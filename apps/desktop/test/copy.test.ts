import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { copyNotes } from '../src/main/vault/copy'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

async function vault(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holi-cp-'))
  dirs.push(root)
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(root, rel, '..'), { recursive: true })
    await writeFile(join(root, rel), text, 'utf8')
  }
  return root
}

describe('copyNotes', () => {
  it('duplicates content verbatim and does NOT rewrite links (copies point at the originals)', async () => {
    const root = await vault({ 'a.md': 'body with [[other.md]]' })
    await copyNotes(root, [{ from: 'a.md', to: 'a copy.md' }])
    // The original survives, and the copy keeps the link untouched.
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('body with [[other.md]]')
    expect(await readFile(join(root, 'a copy.md'), 'utf8')).toBe('body with [[other.md]]')
  })

  it('copies multiple in one call, creating folders on the way', async () => {
    const root = await vault({ 'a.md': 'A', 'b.md': 'B' })
    await copyNotes(root, [
      { from: 'a.md', to: 'dup/a.md' },
      { from: 'b.md', to: 'dup/b.md' },
    ])
    expect(await readFile(join(root, 'dup/a.md'), 'utf8')).toBe('A')
    expect(await readFile(join(root, 'dup/b.md'), 'utf8')).toBe('B')
  })
})
