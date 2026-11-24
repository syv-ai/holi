import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createRouter } from '../src/main/router'
import { GitHubSession } from '../src/main/github/session'
import { TokenStore, type SafeStorageLike } from '../src/main/github/token-store'
import { VaultRegistry } from '../src/main/vault/registry'
import { openRepo } from '../src/main/git'
import type { ActiveVault, VaultHost } from '../src/main/vault/active-vault'

const exec = promisify(execFile)
const REMOTE = 'syv-ai/notes'
const storage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value),
  decryptString: (value) => value.toString(),
}
const dirs: string[] = []
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))),
)

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'holi-history-router-'))
  dirs.push(dir)
  const root = join(dir, 'vault')
  await exec('git', ['init', '-q', root])
  await exec('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
  await exec('git', ['-C', root, 'config', 'user.name', 'Test'])
  const commit = async (text: string) => {
    await writeFile(join(root, 'note.md'), text)
    await exec('git', ['-C', root, 'add', '-A'])
    await exec('git', ['-C', root, 'commit', '-qm', 'snapshot'])
    return (await exec('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim()
  }
  const before = await commit('')
  const after = await commit('latest\n')
  const registry = new VaultRegistry(join(dir, 'vaults.json'))
  await registry.add({ remote: REMOTE, path: root, name: 'notes', lastOpenedAt: '2026-01-01' })
  const tokenStore = new TokenStore(join(dir, 'auth.enc'), storage)
  const session = await GitHubSession.load({
    store: tokenStore,
    fetch: (() => {
      throw new Error('unexpected network')
    }) as typeof fetch,
  })
  let selected: ActiveVault | null = null
  const host = {
    active: () => selected,
    get: () => null,
    prepare: async () => {},
    open: async (remote: string) => {
      const active = {
        remote,
        root,
        repo: openRepo(root),
        snapshot: async () => ({}) as never,
        refresh: async () => {},
      } as ActiveVault
      selected = active
      return active
    },
    getOrOpen: async () => selected,
    close: async () => {
      selected = null
    },
    closeAll: async () => {
      selected = null
    },
  } as unknown as VaultHost
  const plugins = {
    reconcile: async () => {},
    invalidate: () => {},
    setDisplayed: () => {},
    syncBackground: async () => {},
    failures: () => ({}),
    scanClaimsFor: async () => [],
  }
  const caller = createRouter({
    registry,
    session,
    host,
    vaultRoot: join(dir, 'clones'),
    seed: async () => ({ written: [], merged: [], unchanged: [] }),
    plugins,
    prepareClone: async () => {},
    openExternal: async () => {},
    trashItem: async () => {},
    showItemInFolder: () => {},
  }).createCaller({})
  await caller.vaults.open({ remote: REMOTE })
  return { caller, before, after }
}

describe('history.compareRevisions through the public router', () => {
  it('returns exact snapshots, including empty text, and rejects invalid requests', async () => {
    const { caller, before, after } = await fixture()
    await expect(
      caller.history.compareRevisions({ remote: REMOTE, path: 'note.md', before, after }),
    ).resolves.toEqual({ kind: 'text', before: '', after: 'latest\n' })
    await expect(
      caller.history.compareRevisions({ remote: 'other/repo', path: 'note.md', before, after }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(
      caller.history.compareRevisions({ remote: REMOTE, path: 'note.md', before: 'HEAD', after }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      caller.history.compareRevisions({ remote: REMOTE, path: '.env', before, after }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      caller.history.compareRevisions({ remote: REMOTE, path: '../secret', before, after }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('rejects when no vault is active', async () => {
    const { caller, before, after } = await fixture()
    await caller.vaults.close()
    await expect(
      caller.history.compareRevisions({ remote: REMOTE, path: 'note.md', before, after }),
    ).rejects.toBeDefined()
  })
})
