import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { moveNotes } from '../src/main/vault/move'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

async function vault(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holi-mv-'))
  dirs.push(root)
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(root, rel, '..'), { recursive: true })
    await writeFile(join(root, rel), text, 'utf8')
  }
  return root
}

const read = (root: string, rel: string) => readFile(join(root, rel), 'utf8')

describe('moveNotes', () => {
  it('a single move behaves exactly like a rename (file + inbound rewrite)', async () => {
    const root = await vault({
      'old.md': 'body',
      'ref.md': 'see [[old.md]] and [[old.md|Alias]]',
    })
    const { rewritten } = await moveNotes(root, [{ from: 'old.md', to: 'sub/new.md' }])
    expect(rewritten).toEqual([{ path: 'ref.md', count: 2 }])
    await expect(read(root, 'old.md')).rejects.toThrow()
    expect(await read(root, 'sub/new.md')).toBe('body')
    expect(await read(root, 'ref.md')).toBe('see [[sub/new.md]] and [[sub/new.md|Alias]]')
  })

  it('moves a whole folder, remapping inbound links to every file in it', async () => {
    const root = await vault({
      'projects/a.md': 'A',
      'projects/b.md': 'B',
      'index.md': '[[projects/a.md]] and [[projects/b.md]]',
    })
    await moveNotes(root, [
      { from: 'projects/a.md', to: 'work/a.md' },
      { from: 'projects/b.md', to: 'work/b.md' },
    ])
    expect(await read(root, 'work/a.md')).toBe('A')
    expect(await read(root, 'work/b.md')).toBe('B')
    expect(await read(root, 'index.md')).toBe('[[work/a.md]] and [[work/b.md]]')
  })

  it('rewrites a moved file’s OWN outbound link when its target also moved', async () => {
    // b.md links a.md, and both move in the same batch. b's own [[a.md]] must
    // land as [[x/a.md]] at b's new home — the map covers moved files too.
    const root = await vault({
      'a.md': 'A',
      'b.md': 'see [[a.md]]',
    })
    await moveNotes(root, [
      { from: 'a.md', to: 'x/a.md' },
      { from: 'b.md', to: 'x/b.md' },
    ])
    expect(await read(root, 'x/b.md')).toBe('see [[x/a.md]]')
  })

  it('resolves a chain in one pass — a link to a shifted name is NOT double-rewritten', async () => {
    // a→b and b→c together. keep.md’s [[a.md]] must become [[b.md]] (a’s new
    // name), never [[c.md]]. Sequential renames would chain it to c.
    const root = await vault({
      'a.md': 'A',
      'b.md': 'B',
      'keep.md': 'to a: [[a.md]]  to b: [[b.md]]',
    })
    await moveNotes(root, [
      { from: 'a.md', to: 'b.md' },
      { from: 'b.md', to: 'c.md' },
    ])
    // a’s content is now at b.md; b’s content is now at c.md.
    expect(await read(root, 'b.md')).toBe('A')
    expect(await read(root, 'c.md')).toBe('B')
    expect(await read(root, 'keep.md')).toBe('to a: [[b.md]]  to b: [[c.md]]')
  })
})
