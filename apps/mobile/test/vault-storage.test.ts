import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createVaultStorage } from '../app/vault-storage'
import { nodeFiles } from './native-files-node'

const roots: string[] = []
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'holi-vault-storage-'))
  roots.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('vault storage with real directories', () => {
  it('preserves bytes, isolates roots, and rejects stale concurrent saves', async () => {
    const a = await root()
    const b = await root()
    const left = createVaultStorage(nodeFiles, { remote: 'holi/left', root: a })
    const right = createVaultStorage(nodeFiles, { remote: 'holi/right', root: b })
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x0d, 0x0a, 0x65, 0xcc, 0x81])
    const created = await left.create('folder/note.md', bytes)
    await right.create('folder/note.md', new TextEncoder().encode('separate'))
    expect([...(await left.read(created.path)).bytes]).toEqual([...bytes])
    expect(new TextDecoder().decode((await right.read('folder/note.md')).bytes)).toBe('separate')
    const attempts = await Promise.allSettled([
      left.save(created.path, new TextEncoder().encode('one'), created.revision),
      left.save(created.path, new TextEncoder().encode('two'), created.revision),
    ])
    expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    const after = await left.read(created.path)
    await expect(
      left.save(created.path, new TextEncoder().encode('stale'), created.revision),
    ).rejects.toThrow()
    expect(new TextDecoder().decode(after.bytes)).not.toBe('stale')
  })

  it('rejects traversal, case aliases, links and file/directory collisions', async () => {
    const base = await root()
    const outside = await root()
    const store = createVaultStorage(nodeFiles, { remote: 'holi/base', root: base })
    await store.create('Name.md', new TextEncoder().encode('safe'))
    await writeFile(join(outside, 'escape.md'), 'outside')
    await symlink(outside, join(base, 'linked'))
    await expect(store.read('../escape.md')).rejects.toThrow()
    await expect(store.read('missing/child.md')).rejects.toThrow()
    expect(await readdir(base)).not.toContain('missing')
    await expect(store.read('name.md')).rejects.toThrow()
    await expect(store.read('linked/escape.md')).rejects.toThrow()
    await expect(store.create('Name.md/child', new Uint8Array())).rejects.toThrow()
    expect(await readFile(join(outside, 'escape.md'), 'utf8')).toBe('outside')
  })

  it('does not publish local, secret, ignored or internal artifacts', async () => {
    const base = await root()
    const store = createVaultStorage(nodeFiles, { remote: 'holi/filtered', root: base })
    await mkdir(join(base, '.git'))
    await writeFile(join(base, '.git', 'hidden.md'), 'x')
    await writeFile(join(base, 'private.local.md'), 'x')
    await writeFile(join(base, '.env'), 'x')
    await writeFile(join(base, '.holi-storage-owned.tmp'), 'x')
    expect(await store.list()).toEqual([])
    await expect(store.read('.env')).rejects.toThrow()
  })
})
