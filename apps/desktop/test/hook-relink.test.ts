/**
 * `relink` — rewrite inbound `[[links]]` for a file that moved outside Holi.
 *
 * `AGENTS.md` tells the agent to grep and rewrite by hand before moving a file.
 * That instruction is followed inconsistently and silently produces dangling
 * links. This makes the vault's own commit do it.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { relink } from '../src/main/vault/hooks/relink'
import type { StagedChanges } from '../src/main/vault/hooks/staged'

let root: string
const dirs: string[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-relink-'))
  dirs.push(root)
})

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function file(rel: string, text: string): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), text, 'utf8')
}

const read = (rel: string) => readFile(join(root, rel), 'utf8')

const staged = (renamed: { from: string; to: string }[]): StagedChanges => ({
  added: [],
  modified: [],
  renamed,
})

describe('relink', () => {
  it('rewrites an inbound link to the new path', async () => {
    await file('c.md', 'see [[a.md]] for details\n')
    await file('sub/b.md', '# moved\n')

    const result = await relink(root, staged([{ from: 'a.md', to: 'sub/b.md' }]))
    expect(result.changed).toEqual(['c.md'])
    expect(await read('c.md')).toBe('see [[sub/b.md]] for details\n')
  })

  it('keeps the label', async () => {
    await file('c.md', 'see [[a.md|the old note]]\n')
    await file('b.md', '# moved\n')

    await relink(root, staged([{ from: 'a.md', to: 'b.md' }]))
    expect(await read('c.md')).toBe('see [[b.md|the old note]]\n')
  })

  it('resolves a chain in one pass rather than double-rewriting', async () => {
    // a→b and b→c in the same commit. `[[a.md]]` must land on `b.md` and STOP:
    // chaining it on to `c.md` is what N sequential single-target rewrites do,
    // and it is why this reuses `rewriteWikiLinksMulti` (see move.ts).
    await file('notes.md', '[[a.md]] and [[b.md]]\n')
    await file('b.md', '# was a\n')
    await file('c.md', '# was b\n')

    await relink(root, staged([{ from: 'a.md', to: 'b.md' }, { from: 'b.md', to: 'c.md' }]))
    expect(await read('notes.md')).toBe('[[b.md]] and [[c.md]]\n')
  })

  it('rewrites links inside the renamed file itself', async () => {
    await file('sub/b.md', 'I refer to [[other.md]] and to [[a.md]]\n')
    await file('other2.md', '# x\n')

    await relink(
      root,
      staged([
        { from: 'a.md', to: 'sub/b.md' },
        { from: 'other.md', to: 'other2.md' },
      ]),
    )
    expect(await read('sub/b.md')).toBe('I refer to [[other2.md]] and to [[sub/b.md]]\n')
  })

  it('leaves an untargeted link alone', async () => {
    await file('c.md', 'see [[keep.md]] and [[a.md]]\n')
    await file('b.md', '# moved\n')

    await relink(root, staged([{ from: 'a.md', to: 'b.md' }]))
    expect(await read('c.md')).toBe('see [[keep.md]] and [[b.md]]\n')
  })

  it('does not move any file — git already did that', async () => {
    await file('b.md', '# already at its new path\n')
    await relink(root, staged([{ from: 'a.md', to: 'b.md' }]))

    expect(await read('b.md')).toBe('# already at its new path\n')
    await expect(read('a.md')).rejects.toThrow()
  })

  it('reads nothing and changes nothing when there are no renames', async () => {
    await file('c.md', 'see [[a.md]]\n')
    const result = await relink(root, staged([]))
    expect(result).toEqual({ changed: [], notes: [] })
    expect(await read('c.md')).toBe('see [[a.md]]\n')
  })

  it('reports only the files it actually rewrote', async () => {
    await file('has-link.md', '[[a.md]]\n')
    await file('no-link.md', 'nothing here\n')
    await file('b.md', '# moved\n')

    const result = await relink(root, staged([{ from: 'a.md', to: 'b.md' }]))
    expect(result.changed).toEqual(['has-link.md'])
  })

  it('only touches markdown', async () => {
    await file('data.json', '{"see":"[[a.md]]"}\n')
    await file('b.md', '# moved\n')

    const result = await relink(root, staged([{ from: 'a.md', to: 'b.md' }]))
    expect(result.changed).not.toContain('data.json')
    expect(await read('data.json')).toBe('{"see":"[[a.md]]"}\n')
  })

  it('rewrites a link inside a fenced code block, exactly as an in-app rename does', async () => {
    // NOT a feature — `parseWikiLinks` has never skipped fences, so `moveNotes`
    // rewrites them too. Matching that is the point: if this transform were the
    // one place that spared fences, the same move would produce different files
    // depending on whether it happened in Holi or in a terminal, which is a far
    // worse bug than a rewritten link in a code sample. Changing it belongs in
    // the shared parser, for both callers at once.
    await file('doc.md', 'text\n\n```md\n[[a.md]]\n```\n')
    await file('b.md', '# moved\n')

    await relink(root, staged([{ from: 'a.md', to: 'b.md' }]))
    expect(await read('doc.md')).toBe('text\n\n```md\n[[b.md]]\n```\n')
  })
})
