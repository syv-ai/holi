import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as comparisons from '../src/main/vault/compare-revisions'
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
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function pendingComparison() {
  const entered = gate()
  const release = gate()
  const compare = comparisons.compareRevisions
  vi.spyOn(comparisons, 'compareRevisions').mockImplementation(async (...args) => {
    const result = await compare(...args)
    entered.resolve()
    await release.promise
    return result
  })
  return { entered: entered.promise, release: release.resolve }
}

async function fixture(reconcile: (vault: { remote: string }) => Promise<void> = async () => {}) {
  const dir = await mkdtemp(join(tmpdir(), 'holi-history-router-'))
  dirs.push(dir)
  const root = join(dir, 'vault')
  await exec('git', ['init', '-q', root])
  await exec('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
  await exec('git', ['-C', root, 'config', 'user.name', 'Test'])
  await exec('git', ['-C', root, 'config', 'commit.gpgsign', 'false'])
  await exec('git', ['-C', root, 'config', 'tag.gpgsign', 'false'])
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
  const otherRoot = join(dir, 'other-vault')
  await exec('git', ['init', '-q', otherRoot])
  await registry.add({
    remote: 'syv-ai/other',
    path: otherRoot,
    name: 'other',
    lastOpenedAt: '2026-01-01',
  })
  const running = new Map<string, ActiveVault>()
  let selected: ActiveVault | null = null
  const getOrOpen = async (remote: string) => {
    if (running.has(remote)) return running.get(remote)!
    const path = (await registry.list()).find((entry) => entry.remote === remote)!.path
    const active = {
      remote,
      root: path,
      repo: openRepo(path),
      snapshot: async () => ({}) as never,
      refresh: async () => {},
    } as ActiveVault
    running.set(remote, active)
    return active
  }
  const host = {
    active: () => selected,
    get: (remote: string) => running.get(remote) ?? null,
    prepare: async () => {},
    open: async (remote: string) => (selected = await getOrOpen(remote)),
    getOrOpen,
    close: async (remote = selected?.remote) => {
      if (remote) running.delete(remote)
      if (selected?.remote === remote) selected = null
    },
    closeAll: async () => {
      selected = null
      running.clear()
    },
  } as VaultHost
  const plugins = {
    reconcile,
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
  return { caller, before, after, session, host }
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

  it.each(['return visit', 'reopened repository', 'account change'])(
    'rejects an earlier result after a %s',
    async (transition) => {
      const { caller, before, after, session, host } = await fixture()
      const pending = pendingComparison()
      const result = caller.history.compareRevisions({
        remote: REMOTE,
        path: 'note.md',
        before,
        after,
      })
      try {
        await pending.entered
        if (transition === 'return visit') {
          await caller.vaults.open({ remote: 'syv-ai/other' })
          await caller.vaults.open({ remote: REMOTE })
        } else if (transition === 'reopened repository') {
          await host.close()
          await caller.vaults.open({ remote: REMOTE })
        } else {
          await session.signOut()
        }
      } finally {
        pending.release()
      }
      await expect(result).resolves.toEqual({ kind: 'unavailable', reason: 'stale' })
    },
  )

  it('rejects both an earlier read and a new read during an unfinished vault open', async () => {
    const opening = gate()
    const finishOpen = gate()
    const { caller, before, after } = await fixture(async (vault) => {
      if (vault.remote === 'syv-ai/other') {
        opening.resolve()
        await finishOpen.promise
      }
    })
    const pending = pendingComparison()
    const result = caller.history.compareRevisions({
      remote: REMOTE,
      path: 'note.md',
      before,
      after,
    })
    let switched: Promise<unknown> | undefined
    try {
      await pending.entered
      switched = caller.vaults.open({ remote: 'syv-ai/other' })
      await opening.promise
      await expect(
        caller.history.compareRevisions({ remote: 'syv-ai/other', path: 'note.md', before, after }),
      ).resolves.toEqual({ kind: 'unavailable', reason: 'stale' })
      pending.release()
      await expect(result).resolves.toEqual({ kind: 'unavailable', reason: 'stale' })
    } finally {
      pending.release()
      finishOpen.resolve()
      await switched
    }
  })

  it('rejects when no vault is active', async () => {
    const { caller, before, after, host } = await fixture()
    await host.close()
    await expect(
      caller.history.compareRevisions({ remote: REMOTE, path: 'note.md', before, after }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})
