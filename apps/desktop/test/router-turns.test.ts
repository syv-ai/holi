/**
 * The `turns` router (D88), toward #4.
 *
 * Reachability and the seams, not resolution: `rangeFiles` is tested on real
 * repositories in `git-range.test.ts` and the log on disk in `turn-log.test.ts`.
 * What only this rig can prove is that the procedures are registered on the root
 * router and answer over a real vault — a missing registration typechecks fine
 * on the main side and fails at the first call — and that the two seams that
 * touch the user's filesystem behave: a diff side that does not exist answers
 * `''` rather than throwing, and a path outside the vault is refused.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createRouter } from '../src/main/router'
import { createVaultHost, type VaultHost } from '../src/main/vault/active-vault'
import { GitHubSession } from '../src/main/github/session'
import { TokenStore, type SafeStorageLike } from '../src/main/github/token-store'
import { VaultRegistry } from '../src/main/vault/registry'
import { openTurnLog } from '../src/main/agent/turn-log'
import { openRepo } from '../src/main/git'
import { commitFile, makeClone, makeRemote, plainGit } from './helpers/git-fixtures'

const REMOTE = 'syv-ai/turns'

const dirs: string[] = []
const hosts: VaultHost[] = []
afterAll(async () => {
  for (const h of hosts) await h.close()
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

const storage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${Buffer.from(plain, 'utf8').toString('base64')}`),
  decryptString: (buf) => Buffer.from(buf.toString('utf8').slice(4), 'base64').toString('utf8'),
}

/** A real clone behind a real router, with the background loops effectively off
 *  — these tests drive the vault explicitly, as `router.test.ts` does. */
async function rig() {
  const base = await mkdtemp(join(tmpdir(), 'holi-turns-router-'))
  dirs.push(base)
  const root = await makeClone(await makeRemote())
  const registry = new VaultRegistry(join(base, 'vaults.json'))
  await registry.add({
    remote: REMOTE,
    path: root,
    name: 'turns',
    lastOpenedAt: '2026-09-09T00:00:00Z',
  })
  const session = await GitHubSession.load({
    store: new TokenStore(join(base, 'github-auth.enc'), storage),
    fetch: (() => {
      throw new Error('no network in this rig')
    }) as unknown as typeof globalThis.fetch,
  })
  const host = createVaultHost({
    registry,
    onSnapshot: () => {},
    onSyncState: () => {},
    timings: { pullIntervalMs: 3_600_000, healIntervalMs: 3_600_000, commitQuietMs: 3_600_000 },
  })
  hosts.push(host)
  const caller = createRouter({
    registry,
    session,
    host,
    vaultRoot: join(base, 'Holi'),
    openExternal: async () => {},
    trashItem: async () => {},
    downloadsDir: join(base, 'Downloads'),
    typstCacheDir: join(base, 'typst'),
    now: () => '2026-09-09T12:00:00Z',
    today: () => '2026-09-09',
  }).createCaller({})
  await caller.vaults.open({ remote: REMOTE })
  return { caller, root }
}

describe('turns.list', () => {
  it('is empty for a vault that has never run a turn', async () => {
    const { caller } = await rig()
    expect(await caller.turns.list()).toEqual([])
  })

  it('answers with what the log holds, newest first', async () => {
    const { caller, root } = await rig()
    const log = openTurnLog(root)
    await log.append({ base: 'a', end: 'b', at: '2026-09-09T10:00:00Z' })
    await log.append({ base: 'b', end: 'c', at: '2026-09-09T11:00:00Z' })
    const list = await caller.turns.list()
    expect(list.map((r) => r.end)).toEqual(['c', 'b'])
  })
})

describe('turns.files', () => {
  it('reports what the range changed', async () => {
    const { caller, root } = await rig()
    const repo = openRepo(root)
    const base = (await repo.head())!
    await commitFile(root, 'note.md', 'one\ntwo\n')
    const end = (await repo.head())!
    expect(await caller.turns.files({ base, end })).toEqual([
      { path: 'note.md', status: 'A', added: 2, removed: 0 },
    ])
  })

  it('is empty for a range whose shas are gone, rather than an error', async () => {
    // A turn record outlives the commits it names. The panel says "this turn's
    // history is gone"; it must not be handed a throw.
    const { caller, root } = await rig()
    const end = (await openRepo(root).head())!
    expect(await caller.turns.files({ base: '0'.repeat(40), end })).toEqual([])
  })
})

describe('turns.fileDiff', () => {
  it('gives both sides of a modified file', async () => {
    const { caller, root } = await rig()
    const repo = openRepo(root)
    await commitFile(root, 'note.md', 'one\ntwo\n')
    const base = (await repo.head())!
    await commitFile(root, 'note.md', 'one\nCHANGED\n')
    const end = (await repo.head())!
    expect(await caller.turns.fileDiff({ base, end, path: 'note.md' })).toEqual({
      before: 'one\ntwo\n',
      after: 'one\nCHANGED\n',
    })
  })

  it('gives an empty before for a file the turn added', async () => {
    // The side that does not exist is `''`, so the merge view reads it as a pure
    // add rather than failing. Same shape as `history.fileDiff`.
    const { caller, root } = await rig()
    const repo = openRepo(root)
    const base = (await repo.head())!
    await commitFile(root, 'fresh.md', 'new\n')
    const end = (await repo.head())!
    expect(await caller.turns.fileDiff({ base, end, path: 'fresh.md' })).toEqual({
      before: '',
      after: 'new\n',
    })
  })

  it('gives an empty after for a file the turn deleted', async () => {
    const { caller, root } = await rig()
    const repo = openRepo(root)
    await commitFile(root, 'doomed.md', 'bye\n')
    const base = (await repo.head())!
    await rm(join(root, 'doomed.md'))
    await plainGit(root, ['add', '-A'])
    await plainGit(root, ['commit', '-m', 'delete'])
    const end = (await repo.head())!
    expect(await caller.turns.fileDiff({ base, end, path: 'doomed.md' })).toEqual({
      before: 'bye\n',
      after: '',
    })
  })

  it('refuses a path outside the vault', async () => {
    const { caller, root } = await rig()
    const sha = (await openRepo(root).head())!
    await expect(
      caller.turns.fileDiff({ base: sha, end: sha, path: '../../etc/passwd' }),
    ).rejects.toThrow()
  })
})

describe('turns.revert', () => {
  it('writes the resolved text and commits it as a new commit', async () => {
    // Never a history rewrite, the same rule `history.restore` follows.
    const { caller, root } = await rig()
    const repo = openRepo(root)
    await commitFile(root, 'note.md', 'agent wrote this\n')
    const before = (await repo.head())!
    await caller.turns.revert({ remote: REMOTE, path: 'note.md', text: 'I wrote this\n' })
    expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('I wrote this\n')
    expect(await repo.head()).not.toBe(before)
  })

  it('refuses a path outside the vault', async () => {
    const { caller } = await rig()
    await expect(
      caller.turns.revert({ remote: REMOTE, path: '../escape.md', text: 'nope' }),
    ).rejects.toThrow()
  })

  it('does not write the file it refused', async () => {
    const { caller, root } = await rig()
    await writeFile(join(root, 'keep.md'), 'original\n', 'utf8')
    await expect(
      caller.turns.revert({ remote: REMOTE, path: 'keep.md/../../outside.md', text: 'nope' }),
    ).rejects.toThrow()
    expect(await readFile(join(root, 'keep.md'), 'utf8')).toBe('original\n')
  })
})
