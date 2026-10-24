/**
 * Branches: the status bar's picker (docs/features/status-bar.md) and sync
 * following the checked-out branch (docs/features/vaults-sync.md).
 *
 * Real git, as `git.test.ts` and `active-vault.test.ts`: a bare remote, our
 * clone and a teammate's. Nothing is mocked; what is under test is git's own
 * refusals and ref bookkeeping.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { SETTINGS_FILE, taskClaim } from '@holi/shared'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { BranchRefusedError, openRepo, validBranchName } from '../src/main/git'
import { createActivityLog } from '../src/main/activity/log'
import { openActiveVault, type ActiveVault } from '../src/main/vault/active-vault'
import {
  cleanupFixtures,
  commitFile,
  makeClone,
  makeRemote,
  plainGit,
} from './helpers/git-fixtures'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(what: string, predicate: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 8_000
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`)
    await sleep(25)
  }
}
/** See active-vault.test.ts: a fixture quiesces before it is watched. */
const QUIESCE = 150

const open: ActiveVault[] = []
afterEach(async () => {
  for (const v of open.splice(0)) await v.close().catch(() => {})
})
afterAll(cleanupFixtures)

const CLAIMS = async () => [{ ...taskClaim, plugin: 'tasks' }]

/** A remote with `main` and a published `topic`, our clone (on main, with no
 *  local `topic`) and a teammate's. */
async function rigRepos() {
  const origin = await makeRemote()
  const teammate = await makeClone(origin, 'teammate')
  await plainGit(teammate, ['checkout', '-b', 'topic'])
  await commitFile(teammate, 'topic.md', 'on topic\n')
  await plainGit(teammate, ['push', '-u', 'origin', 'topic'])
  await plainGit(teammate, ['checkout', 'main'])
  const dir = await makeClone(origin)
  return { origin, dir, teammate }
}

async function rigVault() {
  const repos = await rigRepos()
  await sleep(QUIESCE)
  const log = createActivityLog()
  const snaps: { docs: { path: string }[] }[] = []
  let committed = 0
  const active = await openActiveVault({
    claims: CLAIMS,
    remote: 'syv-ai/notes',
    repo: openRepo(repos.dir),
    onSnapshot: (s) => snaps.push(s),
    onSyncState: () => {},
    onCommitted: (paths) => {
      if (paths === null) committed++
    },
    activity: log.write,
    // The loops are off; each test drives sync itself.
    timings: {
      commitQuietMs: 60_000,
      pushQuietMs: 60_000,
      pullIntervalMs: 60_000,
      healIntervalMs: 60_000,
    },
  })
  open.push(active)
  const lines = () => log.entries().map((e) => `${e.channel}:${e.level}:${e.message}`)
  return { ...repos, active, lines, snaps, historyMoves: () => committed }
}

const head = (dir: string) => plainGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])

describe('branches()', () => {
  it('lists local branches with their upstream, and remote-only branches apart', async () => {
    const { dir } = await rigRepos()
    await plainGit(dir, ['branch', 'local-only'])
    const list = await openRepo(dir).branches()

    expect(list.current).toBe('main')
    expect(list.local).toContainEqual({ name: 'main', upstream: 'origin/main' })
    expect(list.local).toContainEqual({ name: 'local-only', upstream: null })
    // `topic` is on origin and not here; `main` is here, so not listed twice;
    // `origin/HEAD` is a pointer, not a branch.
    expect(list.remote).toEqual([{ name: 'topic' }])
  })

  it('names the current branch on a detached HEAD as null', async () => {
    const { dir } = await rigRepos()
    await plainGit(dir, ['checkout', '--detach', 'HEAD'])
    expect((await openRepo(dir).branches()).current).toBeNull()
  })
})

describe('switchBranch()', () => {
  it('switches to a local branch', async () => {
    const { dir } = await rigRepos()
    await plainGit(dir, ['branch', 'other'])
    await openRepo(dir).switchBranch('other')
    expect(await head(dir)).toBe('other')
  })

  it('makes a branch that is only on origin a local branch tracking it', async () => {
    const { dir } = await rigRepos()
    await openRepo(dir).switchBranch('topic')
    expect(await head(dir)).toBe('topic')
    expect(await plainGit(dir, ['rev-parse', '--abbrev-ref', 'topic@{upstream}'])).toBe(
      'origin/topic',
    )
    expect(await readFile(join(dir, 'topic.md'), 'utf8')).toBe('on topic\n')
  })

  it('creates a branch at HEAD, with no upstream until its first push', async () => {
    const { dir } = await rigRepos()
    const before = await plainGit(dir, ['rev-parse', 'HEAD'])
    await openRepo(dir).switchBranch('feat/new', { create: true })
    expect(await head(dir)).toBe('feat/new')
    expect(await plainGit(dir, ['rev-parse', 'HEAD'])).toBe(before)
    const list = await openRepo(dir).branches()
    expect(list.local).toContainEqual({ name: 'feat/new', upstream: null })
  })

  it('refuses a name git would not accept, or would rewrite', async () => {
    const { dir } = await rigRepos()
    const repo = openRepo(dir)
    for (const bad of ['-f', 'a..b', 'has space', '@{-1}', '@', 'x.lock', '']) {
      await expect(repo.switchBranch(bad, { create: true })).rejects.toBeInstanceOf(
        BranchRefusedError,
      )
    }
    expect(await validBranchName(dir, 'feat/ok-1')).toBe(true)
    expect(await head(dir)).toBe('main')
  })

  it('refuses to create a branch that exists, and to switch to one that does not', async () => {
    const { dir } = await rigRepos()
    const repo = openRepo(dir)
    await expect(repo.switchBranch('main', { create: true })).rejects.toThrow(/already exists/)
    await expect(repo.switchBranch('nowhere')).rejects.toThrow(/no branch/)
  })

  it('refuses a dirty tree rather than carrying the edit along', async () => {
    const { dir } = await rigRepos()
    await writeFile(join(dir, 'README.md'), '# Changed\n', 'utf8')
    await expect(openRepo(dir).switchBranch('topic')).rejects.toThrow(/not committed/)
    expect(await head(dir)).toBe('main')
  })

  it('refuses mid-merge', async () => {
    const { dir, teammate } = await rigRepos()
    await commitFile(teammate, 'README.md', '# Theirs\n')
    await plainGit(teammate, ['push', 'origin', 'main'])
    await commitFile(dir, 'README.md', '# Ours\n')
    await plainGit(dir, ['fetch', 'origin'])
    await plainGit(dir, ['merge', 'origin/main']).catch(() => {}) // conflicts
    await expect(openRepo(dir).switchBranch('topic')).rejects.toThrow(/merge is in progress/)
  })
})

describe('sync follows the checked-out branch', () => {
  it('pushes a new branch to its namesake and sets the upstream', async () => {
    const { dir, origin } = await rigRepos()
    const repo = openRepo(dir)
    await repo.switchBranch('feat/new', { create: true })
    await commitFile(dir, 'new.md', 'new\n')
    // Unpushed work on a branch with no upstream still counts as ahead.
    expect((await repo.status()).ahead).toBe(1)

    expect(await repo.push()).toEqual({ kind: 'pushed', commits: 1, branch: 'feat/new' })
    expect(await plainGit(dir, ['rev-parse', '--abbrev-ref', 'feat/new@{upstream}'])).toBe(
      'origin/feat/new',
    )
    // main on the remote did not move.
    const check = await makeClone(origin, 'check')
    expect(await readFile(join(check, 'new.md'), 'utf8').catch(() => null)).toBeNull()
    expect((await repo.status()).ahead).toBe(0)
  })

  it('pulls from the branch’s namesake, and finds nothing on a branch never pushed', async () => {
    const { dir, teammate } = await rigRepos()
    const repo = openRepo(dir)
    await repo.switchBranch('topic')
    await plainGit(teammate, ['checkout', 'topic'])
    await commitFile(teammate, 'more.md', 'more\n')
    await plainGit(teammate, ['push', 'origin', 'topic'])
    expect(await repo.pull()).toEqual({ kind: 'merged', commits: 1 })
    expect(await readFile(join(dir, 'more.md'), 'utf8')).toBe('more\n')

    await repo.switchBranch('solo', { create: true })
    expect(await repo.pull()).toEqual({ kind: 'up-to-date' })
  })
})

describe('ActiveVault.switchBranch', () => {
  it('commits pending edits through autosave, on the branch they were made on', async () => {
    const { dir, active, lines } = await rigVault()
    await writeFile(join(dir, 'draft.md'), 'draft\n', 'utf8')
    await active.switchBranch('topic')

    expect(await head(dir)).toBe('topic')
    // The draft was committed on main, so it is not in topic's tree.
    expect(await plainGit(dir, ['ls-tree', '--name-only', 'main'])).toContain('draft.md')
    expect(await readFile(join(dir, 'draft.md'), 'utf8').catch(() => null)).toBeNull()
    expect(lines()).toContain(
      'git:info:Committed ' + (await short(dir, 'main')) + ' Update draft.md',
    )
    expect(lines()).toContain('git:info:Switched to branch topic')
  })

  it('reflects the new tree: a rescan and a history move', async () => {
    const { active, snaps, historyMoves } = await rigVault()
    const before = historyMoves()
    await active.switchBranch('topic')
    expect(snaps.at(-1)?.docs.some((d) => d.path === 'topic.md')).toBe(true)
    expect(historyMoves()).toBe(before + 1)
    expect(active.syncState().kind).toBe('up-to-date')
  })

  it('creates a branch, and its first sync pushes there with the upstream set', async () => {
    const { dir, active, lines } = await rigVault()
    await active.switchBranch('feat/notes', { create: true })
    expect(lines()).toContain('git:info:Created branch feat/notes')

    await writeFile(join(dir, 'idea.md'), 'idea\n', 'utf8')
    await active.syncNow()
    expect(lines()).toContain('git:info:Pushed 1 commit to origin/feat/notes')
    expect(await plainGit(dir, ['rev-parse', '--abbrev-ref', '@{upstream}'])).toBe(
      'origin/feat/notes',
    )
  })

  it('refuses while a conflict is waiting', async () => {
    const { dir, teammate, active } = await rigVault()
    await commitFile(teammate, 'README.md', '# Theirs\n')
    await plainGit(teammate, ['push', 'origin', 'main'])
    await writeFile(join(dir, 'README.md'), '# Ours\n', 'utf8')
    await active.commitNow()
    await active.pushNow()
    expect(active.syncState().kind).toBe('conflict')

    await expect(active.switchBranch('topic')).rejects.toThrow(/conflict is waiting/)
    expect(await head(dir)).toBe('main')
  })

  it('refuses while sync is paused for an agent turn', async () => {
    const { dir, active } = await rigVault()
    active.pause('an agent turn is running')
    await expect(active.switchBranch('topic')).rejects.toThrow(/Sync is paused/)
    expect(await head(dir)).toBe('main')
  })

  it('refuses a dirty tree autosave would not commit', async () => {
    // An oversized file is held back by the size gate, so the tree stays
    // dirty after the settle commit, and git would carry it to the new branch.
    const { dir, active } = await rigVault()
    await mkdir(dirname(join(dir, SETTINGS_FILE)), { recursive: true })
    await writeFile(join(dir, SETTINGS_FILE), '{"maxCommittedFileBytes": 1024}', 'utf8')
    await writeFile(join(dir, 'big.bin'), 'x'.repeat(5000), 'utf8')

    await expect(active.switchBranch('topic')).rejects.toThrow(/1 file is not committed/)
    expect(await head(dir)).toBe('main')
    // The settle commit still took what it could.
    expect(await plainGit(dir, ['ls-tree', '-r', '--name-only', 'HEAD'])).toContain(SETTINGS_FILE)
  })

  it('fetches for the picker at most once per debounce window', async () => {
    const { active, teammate, dir } = await rigVault()
    await plainGit(teammate, ['checkout', '-b', 'later'])
    await plainGit(teammate, ['push', 'origin', 'later'])
    await active.fetchBranches()
    expect((await active.branches()).remote.map((b) => b.name)).toContain('later')

    await plainGit(teammate, ['checkout', '-b', 'even-later'])
    await plainGit(teammate, ['push', 'origin', 'even-later'])
    await active.fetchBranches()
    expect((await active.branches()).remote.map((b) => b.name)).not.toContain('even-later')
    expect(await head(dir)).toBe('main')
  })
})

async function short(dir: string, ref: string): Promise<string> {
  return plainGit(dir, ['rev-parse', '--short=7', ref])
}
