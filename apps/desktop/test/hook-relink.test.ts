/**
 * `relink` — rewrite inbound `[[links]]` for a file that moved outside Holi.
 *
 * `AGENTS.md` tells the agent to grep and rewrite by hand before moving a file.
 * That instruction is followed inconsistently and silently produces dangling
 * links. This makes the vault's own commit do it.
 */
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { SCRATCHPAD_PATH } from '@holi/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { relink } from '../src/main/vault/hooks/relink'
import { stagedChanges, type StagedChanges } from '../src/main/vault/hooks/staged'

const execFile = promisify(execFileCallback)

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

const staged = (
  renamed: { from: string; to: string }[],
  deleted: string[] = [],
): StagedChanges => ({
  added: [],
  modified: [],
  renamed,
  deleted,
})

const exists = (rel: string) =>
  read(rel).then(
    () => true,
    () => false,
  )

describe('relink', () => {
  it("moves a moved note's comment threads with it, and keeps a deleted note's", async () => {
    // A deletion may be a rename git did not pair (moved and rewritten in one
    // commit): deleting the threads then would delete every comment on it.
    await file('sub/b.md', '# moved\n')
    await file('.holi/comments/a.md.json', '{"threads":{}}\n')
    await file('.holi/comments/gone.md.json', '{"threads":{}}\n')

    const result = await relink(root, staged([{ from: 'a.md', to: 'sub/b.md' }], ['gone.md']))
    expect(result.changed).toEqual(['.holi/comments/a.md.json', '.holi/comments/sub/b.md.json'])
    expect(await read('.holi/comments/sub/b.md.json')).toBe('{"threads":{}}\n')
    expect(await exists('.holi/comments/a.md.json')).toBe(false)
    expect(await exists('.holi/comments/gone.md.json')).toBe(true)
  })

  it('preserves exact scratchpad bytes for a git-detected external rename', async () => {
    const scratchpad = Buffer.from('---\r\ntype: daily-note\r\n---\r\n[[old.md]]  \nlast line')
    await file('old.md', '# old\n')
    await file(SCRATCHPAD_PATH, '')
    await writeFile(join(root, SCRATCHPAD_PATH), scratchpad)
    await file('ordinary.md', '[[old.md]]')
    await execFile('git', ['init', '-q'], { cwd: root })
    await execFile('git', ['config', 'user.name', 'Holi Test'], { cwd: root })
    await execFile('git', ['config', 'user.email', 'holi@example.test'], { cwd: root })
    await execFile('git', ['add', '.'], { cwd: root })
    await execFile('git', ['commit', '-qm', 'initial'], { cwd: root })
    await execFile('git', ['mv', 'old.md', 'new.md'], { cwd: root })

    const result = await relink(root, await stagedChanges(root))
    expect(result.changed).toEqual(['ordinary.md'])
    expect(await readFile(join(root, SCRATCHPAD_PATH))).toEqual(scratchpad)
    expect(await read('ordinary.md')).toBe('[[new.md]]')
  })

  it('keeps a scratchpad moved out by git protected while relinking ordinary referrers', async () => {
    const bytes = Buffer.from([0x80, 0xff, 0x5b, 0x5b, ...Buffer.from(SCRATCHPAD_PATH), 0x5d, 0x5d])
    await file(SCRATCHPAD_PATH, '')
    await writeFile(join(root, SCRATCHPAD_PATH), bytes)
    await file('ordinary.md', `[[${SCRATCHPAD_PATH}]]`)
    await execFile('git', ['init', '-q'], { cwd: root })
    await execFile('git', ['config', 'user.name', 'Holi Test'], { cwd: root })
    await execFile('git', ['config', 'user.email', 'holi@example.test'], { cwd: root })
    await execFile('git', ['add', '.'], { cwd: root })
    await execFile('git', ['commit', '-qm', 'initial'], { cwd: root })
    await execFile('git', ['mv', SCRATCHPAD_PATH, 'personal.md'], { cwd: root })

    const staged = await stagedChanges(root)
    expect(staged.renamed).toEqual([{ from: SCRATCHPAD_PATH, to: 'personal.md' }])
    const result = await relink(root, staged)

    expect(result.changed).toEqual(['ordinary.md'])
    expect(await readFile(join(root, 'personal.md'))).toEqual(bytes)
    expect(await read('ordinary.md')).toBe('[[personal.md]]')
    const after = await stagedChanges(root)
    expect(after.renamed).toEqual(staged.renamed)
    expect(after.modified).toEqual([])
    const { stdout } = await execFile('git', ['diff', '--name-only'], { cwd: root })
    expect(stdout.trim().split('\n')).toEqual(['ordinary.md'])
  })

  it('preserves a git move into the scratchpad while updating ordinary references', async () => {
    const bytes = Buffer.from([0x80, 0xff, 0x5b, 0x5b, ...Buffer.from('incoming.md'), 0x5d, 0x5d])
    await file('incoming.md', '')
    await writeFile(join(root, 'incoming.md'), bytes)
    await file('ordinary.md', '[[incoming.md]]')
    await execFile('git', ['init', '-q'], { cwd: root })
    await execFile('git', ['config', 'user.name', 'Holi Test'], { cwd: root })
    await execFile('git', ['config', 'user.email', 'holi@example.test'], { cwd: root })
    await execFile('git', ['add', '.'], { cwd: root })
    await execFile('git', ['commit', '-qm', 'initial'], { cwd: root })
    await execFile('git', ['mv', 'incoming.md', SCRATCHPAD_PATH], { cwd: root })

    const staged = await stagedChanges(root)
    expect(staged.renamed).toEqual([{ from: 'incoming.md', to: SCRATCHPAD_PATH }])
    const result = await relink(root, staged)

    expect(result.changed).toEqual(['ordinary.md'])
    expect(await readFile(join(root, SCRATCHPAD_PATH))).toEqual(bytes)
    expect(await read('ordinary.md')).toBe(`[[${SCRATCHPAD_PATH}]]`)
    const after = await stagedChanges(root)
    expect(after.renamed).toEqual(staged.renamed)
    expect(after.modified).toEqual([])
    const { stdout } = await execFile('git', ['diff', '--name-only'], { cwd: root })
    expect(stdout.trim().split('\n')).toEqual(['ordinary.md'])
  })

  it('keeps protection on the original scratchpad in a simultaneous rename chain', async () => {
    const scratchpad = '# scratchpad\n' + 'personal draft '.repeat(100) + `\n[[${SCRATCHPAD_PATH}]]`
    const ordinary = '# ordinary\n' + 'ordinary retained prose '.repeat(100) + '\n[[target.md]]'
    await file(SCRATCHPAD_PATH, scratchpad)
    await file('personal.md', ordinary)
    await file('target.md', '# target\n' + 'target content '.repeat(100))
    await file('ref.md', `[[${SCRATCHPAD_PATH}]]`)
    await execFile('git', ['init', '-q'], { cwd: root })
    await execFile('git', ['config', 'user.name', 'Holi Test'], { cwd: root })
    await execFile('git', ['config', 'user.email', 'holi@example.test'], { cwd: root })
    await execFile('git', ['add', '.'], { cwd: root })
    await execFile('git', ['commit', '-qm', 'initial'], { cwd: root })
    await execFile('git', ['mv', 'personal.md', 'archive.md'], { cwd: root })
    await execFile('git', ['mv', SCRATCHPAD_PATH, 'personal.md'], { cwd: root })
    await execFile('git', ['mv', 'target.md', 'renamed.md'], { cwd: root })

    // Breaking a complete rewrite exposes both original file identities.
    const { stdout: names } = await execFile(
      'git',
      ['diff', '--cached', '--name-status', '-B', '-M', '-z'],
      { cwd: root },
    )
    const pairs = [
      { from: SCRATCHPAD_PATH, to: 'personal.md' },
      { from: 'personal.md', to: 'archive.md' },
      { from: 'target.md', to: 'renamed.md' },
    ]
    for (const { from, to } of pairs) expect(names).toContain(`R100\0${from}\0${to}\0`)
    const result = await relink(root, staged(pairs))

    expect(await read('personal.md')).toBe(scratchpad)
    expect(await read('archive.md')).toBe(ordinary.replace('[[target.md]]', '[[renamed.md]]'))
    expect(await read('ref.md')).toBe('[[personal.md]]')
    expect(result.changed).toEqual(['archive.md', 'ref.md'])
    const { stdout } = await execFile('git', ['diff', '--name-only'], { cwd: root })
    expect(stdout.trim().split('\n')).toEqual(result.changed)
  })

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

    await relink(
      root,
      staged([
        { from: 'a.md', to: 'b.md' },
        { from: 'b.md', to: 'c.md' },
      ]),
    )
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

describe('a second actor doing the same job', () => {
  it('is a no-op, not a double rewrite', async () => {
    // The plan feared that an agent grepping and fixing links by hand, then
    // committing, would have them rewritten twice. It cannot: the map is keyed
    // on the OLD path, and after a hand-fix that path appears nowhere, so the
    // rewrite matches nothing. Worth an assertion because the fear shaped the
    // AGENTS.md wording.
    await file('c.md', 'see [[b.md]]\n') // already fixed by hand
    await file('b.md', '# moved\n')

    const result = await relink(root, staged([{ from: 'a.md', to: 'b.md' }]))
    expect(result.changed).toEqual([])
    expect(await read('c.md')).toBe('see [[b.md]]\n')
  })

  it('fixes only the links the hand-pass missed', async () => {
    await file('fixed.md', 'see [[b.md]]\n')
    await file('missed.md', 'see [[a.md]]\n')
    await file('b.md', '# moved\n')

    const result = await relink(root, staged([{ from: 'a.md', to: 'b.md' }]))
    expect(result.changed).toEqual(['missed.md'])
    expect(await read('fixed.md')).toBe('see [[b.md]]\n')
    expect(await read('missed.md')).toBe('see [[b.md]]\n')
  })
})
