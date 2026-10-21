import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { renameNote } from '../src/main/vault/rename'

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
