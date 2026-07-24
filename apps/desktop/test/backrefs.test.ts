import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { scanBackrefs, scanBackrefsMany } from '../src/main/vault/backrefs'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

async function vault(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holi-br-'))
  dirs.push(root)
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, text, 'utf8')
  }
  return root
}

describe('scanBackrefs', () => {
  it('counts note-links to the target, skips task chips and the file itself', async () => {
    const root = await vault({
      'a.md': 'see [[notes/target.md]] and also [[notes/target.md|Label]]',
      'b.md': 'one [[notes/target.md]] plus a [[task:xyz]] chip',
      'c.md': 'nothing linked here',
      'notes/target.md': 'a self reference [[notes/target.md]] does not count',
    })
    expect(await scanBackrefs(root, 'notes/target.md')).toEqual([
      { path: 'a.md', count: 2 },
      { path: 'b.md', count: 1 },
    ])
  })

  it('returns an empty array when nothing links to the target', async () => {
    const root = await vault({ 'a.md': 'plain note' })
    expect(await scanBackrefs(root, 'notes/target.md')).toEqual([])
  })
})

describe('scanBackrefsMany', () => {
  it('counts external inbound links to any target, EXCLUDING links from within the set', async () => {
    // Deleting the folder {p/a.md, p/b.md} wholesale: a→b inside the set is not
    // "left dangling", so it must not be reported. outside.md IS an external ref.
    const root = await vault({
      'p/a.md': 'links [[p/b.md]]',
      'p/b.md': 'the other',
      'outside.md': 'refers [[p/a.md]] and [[p/b.md]]',
    })
    expect(await scanBackrefsMany(root, ['p/a.md', 'p/b.md'])).toEqual([
      { path: 'outside.md', count: 2 },
    ])
  })

  it('returns an empty array when nothing outside the set links in', async () => {
    const root = await vault({ 'p/a.md': 'lonely', 'q.md': 'unrelated' })
    expect(await scanBackrefsMany(root, ['p/a.md'])).toEqual([])
  })
})
