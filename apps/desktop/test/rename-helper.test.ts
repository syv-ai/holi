import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { exactPath } from '@holi/shared/path-safety-node'
import { moveNotes } from '../src/main/vault/move'
import { renameNote } from '../src/main/vault/rename'
import { withFileLock } from '../src/main/vault/vault-files'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

async function vault(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holi-rn-'))
  dirs.push(root)
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(root, rel, '..'), { recursive: true })
    await writeFile(join(root, rel), text, 'utf8')
  }
  return root
}

describe('renameNote', () => {
  it('rewrites a linking note under its lock, keeping a save made meanwhile', async () => {
    const root = await vault({ 'old.md': 'body', 'ref.md': 'see [[old.md]]' })
    let open!: () => void
    const gate = new Promise<void>((r) => (open = r))
    const save = withFileLock((await exactPath(root, 'ref.md'))!, async () => {
      await gate
      await writeFile(join(root, 'ref.md'), 'saved [[old.md]]', 'utf8')
    })
    const rename = renameNote(root, 'old.md', 'new.md')
    await new Promise((r) => setTimeout(r, 50))
    open()
    await Promise.all([save, rename])
    expect(await readFile(join(root, 'ref.md'), 'utf8')).toBe('saved [[new.md]]')
  })

  it('waits for a folder move under way, so neither undoes the other', async () => {
    const root = await vault({ 't.md': 'task', 'd.md': 'done, see [[t.md]]' })
    await Promise.all([
      moveNotes(root, [{ from: 'd.md', to: 'archive/d.md' }]),
      renameNote(root, 't.md', 'lane/t.md'),
    ])
    expect(await readFile(join(root, 'archive/d.md'), 'utf8')).toBe('done, see [[lane/t.md]]')
    await expect(readFile(join(root, 'd.md'), 'utf8')).rejects.toThrow()
  })

  it('moves the file and rewrites inbound links, returning the referrers', async () => {
    const root = await vault({
      'old.md': 'the body',
      'ref.md': 'see [[old.md]] and again [[old.md]]',
    })
    const result = await renameNote(root, 'old.md', 'sub/new.md')

    expect(result).toEqual({ rewritten: [{ path: 'ref.md', count: 2 }] })
    await expect(readFile(join(root, 'old.md'), 'utf8')).rejects.toThrow()
    expect(await readFile(join(root, 'sub/new.md'), 'utf8')).toBe('the body')
    expect(await readFile(join(root, 'ref.md'), 'utf8')).toBe(
      'see [[sub/new.md]] and again [[sub/new.md]]',
    )
  })

  it("takes the note's comment threads along, merging with any left at the destination", async () => {
    // At the move, not at the commit: a rename then an edit before the commit
    // no longer reads as a rename to git, and the threads would stay behind.
    const thread = (id: string) =>
      `{"threads":{"${id}":{"anchor":{"quote":"x","prefix":"","suffix":"","line":1},"comments":{}}}}\n`
    const root = await vault({
      'old.md': 'the body',
      '.holi/comments/old.md.json': thread('mine'),
      // The threads of a note deleted at `new.md` earlier, kept.
      '.holi/comments/new.md.json': thread('kept'),
    })
    await renameNote(root, 'old.md', 'new.md')
    await expect(readFile(join(root, '.holi/comments/old.md.json'), 'utf8')).rejects.toThrow()
    const moved = JSON.parse(await readFile(join(root, '.holi/comments/new.md.json'), 'utf8'))
    expect(Object.keys(moved.threads).sort()).toEqual(['kept', 'mine'])
  })
})
