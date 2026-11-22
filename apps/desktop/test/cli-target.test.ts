import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { VaultEntry } from '@holi/shared'
import { createCliTargetResolver } from '../src/main/bridge/cli-target'

describe('registered CLI targets', () => {
  let dir: string
  let entries: VaultEntry[]
  let live: { remote: string; root: string } | null
  const resolver = () =>
    createCliTargetResolver(
      { list: async () => entries },
      (remote, root) => live?.remote === remote && live.root === root,
    )
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'holi-cli-target-')))
    entries = ['a', 'b'].map((name) => ({
      remote: `owner/${name}`,
      name,
      path: join(dir, name),
      lastOpenedAt: '2026-01-01',
    }))
    await Promise.all(entries.map((entry) => mkdir(entry.path)))
    live = { remote: 'owner/b', root: entries[1]!.path }
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('matches physical nested cwd without a displayed-vault fallback', async () => {
    const nested = join(entries[0]!.path, 'notes', 'deep')
    await mkdir(nested, { recursive: true })
    expect(await resolver().resolve(null, nested)).toMatchObject({
      entry: { remote: 'owner/a' },
      live: false,
    })
    expect(await resolver().resolve(null, dir)).toBeNull()
    await expect(resolver().resolve(null, 'a')).rejects.toThrow('absolute')
  })
  it('uses stored identity and canonical registered roots for explicit targets', async () => {
    expect(await resolver().resolve('OWNER/A', null)).toMatchObject({
      entry: entries[0],
      live: false,
    })
    expect(await resolver().resolve('owner/unknown', null)).toBeNull()
    await expect(resolver().resolve('../a', null)).rejects.toThrow('invalid')
    expect(await resolver().list()).toEqual([
      { remote: 'owner/a', name: 'a', live: false },
      { remote: 'owner/b', name: 'b', live: true },
    ])
  })
  it('does not treat symlink escapes or prefix siblings as a clone cwd', async () => {
    await symlink(dir, join(entries[0]!.path, 'escape'))
    expect(await resolver().resolve(null, join(entries[0]!.path, 'escape'))).toBeNull()
    const sibling = join(dir, 'a-other')
    await mkdir(sibling)
    expect(await resolver().resolve(null, sibling)).toBeNull()
  })
  it('rejects case-folded identities and two remotes pointing at the same canonical root', async () => {
    entries.push({ ...entries[0]!, remote: 'OWNER/A' })
    await expect(resolver().resolve('owner/a', null)).rejects.toThrow('ambiguous')
    entries.pop()
    const alias = join(dir, 'alias')
    await symlink(entries[0]!.path, alias)
    entries.push({ ...entries[1]!, remote: 'owner/alias', path: alias })
    await expect(resolver().resolve('owner/a', null)).rejects.toThrow('canonical')
  })
  it('rechecks removed or moved registry roots and does not mark another clone live', async () => {
    const old = entries[1]!
    entries[1] = { ...old, path: entries[0]!.path }
    entries.shift()
    expect(await resolver().resolve('owner/b', null)).toMatchObject({
      entry: { path: entries[0]!.path },
      live: false,
    })
    entries = []
    expect(await resolver().resolve('owner/b', null)).toBeNull()
    expect(await resolver().list()).toEqual([])
  })
  it('lists unavailable clones without claiming they are live', async () => {
    await rm(entries[1]!.path, { recursive: true })
    expect((await resolver().list())[1]?.live).toBe(false)
    await expect(resolver().resolve('owner/b', null)).rejects.toThrow('unavailable')
  })
})
