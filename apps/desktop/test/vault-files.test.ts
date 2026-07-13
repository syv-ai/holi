import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { vaultRelPath } from '@holi/shared'
import {
  absPathFor,
  isIgnoredPath,
  listFiles,
  moveDocFile,
  removeDocFile,
  toVaultRel,
  writeAtomic,
} from '../src/main/vault/vault-files'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})
async function scratch(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'holi-vf-'))
  dirs.push(d)
  return d
}

describe('vault-files', () => {
  it('writeAtomic creates parents and leaves no tmp files', async () => {
    const root = await scratch()
    await writeAtomic(root, vaultRelPath('a/b/c.md'), 'hello\n')
    expect(await readFile(join(root, 'a/b/c.md'), 'utf8')).toBe('hello\n')
    expect(await listFiles(root)).toEqual(['a/b/c.md'])
  })

  it('toVaultRel maps abs→rel and rejects escapes', async () => {
    const root = await scratch()
    expect(toVaultRel(root, join(root, 'notes/x.md'))).toBe('notes/x.md')
    expect(toVaultRel(root, join(root, '..', 'outside.md'))).toBeNull()
    expect(toVaultRel(root, '/etc/passwd')).toBeNull()
  })

  it('isIgnoredPath: local-only, tmp markers, junk', () => {
    expect(isIgnoredPath('USER.md')).toBe(true)
    expect(isIgnoredPath('.holi/settings.local.json')).toBe(true)
    expect(isIgnoredPath('notes/.holi-tmp-abc123')).toBe(true)
    expect(isIgnoredPath('.DS_Store')).toBe(true)
    expect(isIgnoredPath('notes/a.md')).toBe(false)
    expect(isIgnoredPath('.claude/settings.json')).toBe(false)
  })

  it('move + remove', async () => {
    const root = await scratch()
    await writeAtomic(root, vaultRelPath('a.md'), 'x')
    await moveDocFile(root, vaultRelPath('a.md'), vaultRelPath('sub/b.md'))
    expect(await listFiles(root)).toEqual(['sub/b.md'])
    await removeDocFile(root, vaultRelPath('sub/b.md'))
    expect(await listFiles(root)).toEqual([])
    await removeDocFile(root, vaultRelPath('sub/b.md')) // idempotent
  })

  it('listFiles walks nested dirs and returns /-separated rels', async () => {
    const root = await scratch()
    await mkdir(join(root, 'x/y'), { recursive: true })
    await writeFile(join(root, 'x/y/z.md'), '1')
    await writeFile(join(root, 'top.md'), '2')
    expect((await listFiles(root)).sort()).toEqual(['top.md', 'x/y/z.md'])
  })
})
