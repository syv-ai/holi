import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { VaultRegistry, clonePathFor, isRemote, repoName } from '../src/main/vault/registry'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})
async function scratch(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'holi-reg-'))
  dirs.push(d)
  return d
}

const entry = (remote: string, at = '2026-07-21T10:00:00Z') => ({
  remote,
  path: `/Holi/${remote}`,
  name: repoName(remote),
  lastOpenedAt: at,
})

describe('isRemote', () => {
  it('accepts owner/repo', () => {
    expect(isRemote('syv-ai/1brain')).toBe(true)
    expect(isRemote('nthomsencph/my.vault')).toBe(true)
  })

  it('rejects anything that would escape the managed root', () => {
    // The remote becomes a filesystem path under ~/Holi.
    expect(isRemote('../../etc/passwd')).toBe(false)
    expect(isRemote('owner/../../etc')).toBe(false)
    expect(isRemote('a/b/c')).toBe(false)
    expect(isRemote('/owner/repo')).toBe(false)
    expect(isRemote('owner/')).toBe(false)
    expect(isRemote('owner')).toBe(false)
  })
})

describe('clonePathFor', () => {
  it('nests the clone by owner and repo', () => {
    expect(clonePathFor('/Holi', 'syv-ai/1brain')).toBe(join('/Holi', 'syv-ai', '1brain'))
  })

  it('refuses a remote that is not owner/repo', () => {
    expect(() => clonePathFor('/Holi', '../etc')).toThrow(/owner\/repo/)
  })
})

describe('VaultRegistry', () => {
  const file = async () => join(await scratch(), 'vaults.json')

  it('is empty before anything is added', async () => {
    await expect(new VaultRegistry(await file()).list()).resolves.toEqual([])
  })

  it('round-trips through disk', async () => {
    const path = await file()
    await new VaultRegistry(path).add(entry('syv-ai/1brain'))
    await expect(new VaultRegistry(path).list()).resolves.toEqual([entry('syv-ai/1brain')])
  })

  it('lists most-recently-opened first', async () => {
    const reg = new VaultRegistry(await file())
    await reg.add(entry('a/one', '2026-07-01T00:00:00Z'))
    await reg.add(entry('b/two', '2026-07-20T00:00:00Z'))
    expect((await reg.list()).map((e) => e.remote)).toEqual(['b/two', 'a/one'])
  })

  it('adding the same remote twice replaces rather than duplicates', async () => {
    const reg = new VaultRegistry(await file())
    await reg.add(entry('a/one'))
    await reg.add({ ...entry('a/one'), name: 'renamed' })
    const all = await reg.list()
    expect(all).toHaveLength(1)
    expect(all[0]!.name).toBe('renamed')
  })

  it('touch moves a vault to the head of the list', async () => {
    const reg = new VaultRegistry(await file())
    await reg.add(entry('a/one', '2026-07-01T00:00:00Z'))
    await reg.add(entry('b/two', '2026-07-20T00:00:00Z'))
    await reg.touch('a/one', '2026-07-21T00:00:00Z')
    expect((await reg.list()).map((e) => e.remote)).toEqual(['a/one', 'b/two'])
  })

  it('touching an unknown remote is a no-op, not an error', async () => {
    const reg = new VaultRegistry(await file())
    await expect(reg.touch('nope/nope', '2026-07-21T00:00:00Z')).resolves.toBeUndefined()
  })

  it('removes', async () => {
    const reg = new VaultRegistry(await file())
    await reg.add(entry('a/one'))
    await expect(reg.remove('a/one')).resolves.toEqual([])
  })

  it('survives a corrupt registry instead of bricking the vault list', async () => {
    // No way back from a blank switcher, so a bad file must degrade, not throw.
    const path = await file()
    await writeFile(path, 'not json at all', 'utf8')
    await expect(new VaultRegistry(path).list()).resolves.toEqual([])
  })

  it('drops entries that do not parse, keeping the ones that do', async () => {
    const path = await file()
    await writeFile(path, JSON.stringify([entry('a/one'), { remote: 'garbage' }]), 'utf8')
    expect((await new VaultRegistry(path).list()).map((e) => e.remote)).toEqual(['a/one'])
  })
})
