import { SETTINGS_FILE } from '@holi/shared'
/**
 * The open vault: what it sees, when it commits, and when it syncs.
 *
 * Every test runs against a real clone of a real bare repo, with a second clone
 * playing the teammate — the same rig `git.test.ts` uses, for the same reason.
 * Nothing here mocks git or the filesystem; the whole design rests on git's
 * refusal to merge and on the watcher's unreliability, and neither survives a
 * mock.
 *
 * Timings are shrunk per test. `fileParallelism: false` is what keeps these
 * honest — read the comment in vitest.config.ts before touching a wait.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { GitError, openRepo } from '../src/main/git'
import type { HeldBackFile } from '../src/main/vault/large-files'
import {
  createVaultHost,
  openActiveVault,
  type ActiveVault,
  type SyncTimings,
  type VaultHost,
} from '../src/main/vault/active-vault'
import { VaultRegistry } from '../src/main/vault/registry'
import { cleanupFixtures, makeClone, makeRemote, plainGit, tmp } from './helpers/git-fixtures'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Long enough that a fire would have landed. Used for ABSENCE assertions,
 *  where there is no condition to wait on. */
const SETTLE = 400

/**
 * Wait until `predicate` holds, or fail.
 *
 * Used instead of `sleep()` for every assertion that something *did* happen,
 * and the distinction is not stylistic. One commit cycle is `status()` →
 * `commitAll` → `status()`, which spawns roughly ten git processes; measured, it
 * frequently runs past 400 ms and occasionally past a second. A fixed sleep
 * either flakes or has to be padded to the worst case, and padding a wait to
 * hide a slow operation is how a suite becomes both slow and unreliable.
 *
 * Polling returns the moment the condition is true, so the common case stays
 * fast and the timeout only bounds the failure.
 */
async function waitFor(
  what: string,
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 8_000,
) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`)
    await sleep(25)
  }
}
/** See vault-watcher.test.ts: macOS replays FSEvents from just before a watcher
 * became ready, so a fixture must quiesce before it is watched. Measured. */
const QUIESCE = 150

/**
 * Vaults opened by the test that is currently running.
 *
 * Torn down after EACH test rather than at the end of the file, and that is not
 * tidiness. A live `ActiveVault` keeps a watcher and two timers running, each
 * tick spawning several git processes — so leaving 40 of them alive for the
 * length of the suite means the last tests run against dozens of vaults all
 * polling repositories that no longer exist. It surfaces as `git` failing to
 * spawn at all (reported, wonderfully, as "git was not found"), in whichever
 * test happens to be running at the time.
 */
const open: ActiveVault[] = []
afterEach(async () => {
  for (const v of open.splice(0)) await v.close().catch(() => {})
})
afterAll(cleanupFixtures)

/** Collects the snapshots pushed to the renderer. */
function snapshots() {
  const all: VaultSnapshotLike[] = []
  let wake: (() => void) | null = null
  return {
    push: (s: VaultSnapshotLike) => {
      all.push(s)
      wake?.()
      wake = null
    },
    get count() {
      return all.length
    },
    get last() {
      return all.at(-1)!
    },
    /** Resolves on the next push, rejects if none arrives. */
    next(ms = SETTLE): Promise<void> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no snapshot was pushed')), ms)
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    },
  }
}
type VaultSnapshotLike = { docs: { path: string }[]; tasks: { path: string }[]; broken: unknown[] }

const paths = (s: VaultSnapshotLike) => s.docs.map((d) => d.path).sort()

async function vault(timings?: Parameters<typeof openActiveVault>[0]['timings']) {
  const origin = await makeRemote()
  const dir = await makeClone(origin)
  await sleep(QUIESCE)
  const snaps = snapshots()
  const active = await openActiveVault({
    remote: 'syv-ai/notes',
    repo: openRepo(dir),
    onSnapshot: snaps.push,
    onSyncState: () => {},
    timings,
  })
  open.push(active)
  return { active, snaps, dir, origin }
}

describe('ActiveVault — snapshot', () => {
  it('scans on open, before any event fires', async () => {
    const { active } = await vault()
    expect(paths(active.snapshot())).toEqual(['README.md'])
  })

  it('pushes a snapshot when a note appears', async () => {
    const { active, snaps, dir } = await vault({ rescanDebounceMs: 30 })

    await writeFile(join(dir, 'hello.md'), '# Hello\n', 'utf8')
    await snaps.next()

    expect(paths(snaps.last)).toEqual(['README.md', 'hello.md'])
    expect(paths(active.snapshot())).toEqual(['README.md', 'hello.md'])
  })

  it('parses a task file into the snapshot, not just its path', async () => {
    // Proves the push carries scanVault's work rather than a directory listing.
    const { snaps, dir } = await vault({ rescanDebounceMs: 30 })

    await writeFile(
      join(dir, 'task.ship-it.md'),
      '---\ntitle: Ship it\nstatus: todo\n---\n\nbody\n',
      'utf8',
    )
    await snaps.next()

    expect(snaps.last.tasks.map((t) => t.path)).toEqual(['task.ship-it.md'])
  })

  it('pushes a snapshot when a file is deleted', async () => {
    const { snaps, dir } = await vault({ rescanDebounceMs: 30 })

    await rm(join(dir, 'README.md'))
    await snaps.next()

    expect(paths(snaps.last)).toEqual([])
  })

  it('heals a change the watcher never reported', async () => {
    // The justification for decision 6, made into a test. The macOS backend
    // genuinely drops add/unlink events, so correctness cannot rest on
    // delivery. Rather than trying to make the OS drop one, the debounce is set
    // beyond the lifetime of the test — an event that never fires and one that
    // fires too late are the same thing to the caller.
    const { active, dir } = await vault({ rescanDebounceMs: 60_000, healIntervalMs: 80 })

    await writeFile(join(dir, 'unseen.md'), 'nobody told us\n', 'utf8')
    await sleep(500)

    expect(paths(active.snapshot())).toEqual(['README.md', 'unseen.md'])
  })

  it('stops pushing after close()', async () => {
    const { active, snaps, dir } = await vault({ rescanDebounceMs: 30, healIntervalMs: 80 })
    await active.close()
    const before = snaps.count

    await writeFile(join(dir, 'after.md'), 'too late\n', 'utf8')
    await sleep(SETTLE)

    expect(snaps.count).toBe(before)
  })

  it('leaves no timer running after close()', async () => {
    // A leaked heal interval keeps scanning a directory a test has already
    // deleted, and the failure surfaces somewhere unrelated.
    const { active, snaps } = await vault({ healIntervalMs: 50 })
    await active.close()
    const before = snaps.count

    await sleep(SETTLE)
    expect(snaps.count).toBe(before)
  })

  it('survives the vault directory disappearing under it', async () => {
    // Not hypothetical: a user can delete a clone in Finder while Holi holds it.
    // A rescan that throws must not take down the heal loop.
    const { active, dir } = await vault({ healIntervalMs: 50 })
    await rm(dir, { recursive: true, force: true })
    await sleep(300)

    expect(active.snapshot().docs).toEqual([])
  })
})

describe('ActiveVault — commit', () => {
  const count = async (dir: string) => Number(await plainGit(dir, ['rev-list', '--count', 'HEAD']))
  const subject = async (dir: string) => plainGit(dir, ['log', '-1', '--format=%s'])

  /** Timings for a loop that commits promptly. */
  const quick = { rescanDebounceMs: 30, commitQuietMs: 60, healIntervalMs: 60_000 }

  it('commits a dirty tree once the edits stop', async () => {
    const { active, dir } = await vault(quick)
    const before = await count(dir)

    await writeFile(join(dir, 'note.md'), 'a thought\n', 'utf8')
    await waitFor('the autosave commit', async () => (await count(dir)) === before + 1)

    expect((await active.repo.status()).dirty).toBe(false) // FR-7
  })

  it('commits a tree that was ALREADY dirty when the vault opened', async () => {
    // Found by running the app. Seeding writes AGENTS.md and friends before the
    // watcher exists, so no filesystem event ever fires for them — and with the
    // commit driven only by the watcher and the heal tick, the first open of
    // every adopted repo left the tree unmergeable for up to a whole heal
    // interval. A vault quit mid-edit reopens the same way.
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    await writeFile(join(dir, 'left-behind.md'), 'from before we were watching\n', 'utf8')
    await sleep(QUIESCE)
    const before = await count(dir)

    const active = await openActiveVault({
      remote: 'syv-ai/notes',
      repo: openRepo(dir),
      onSnapshot: () => {},
      onSyncState: () => {},
      // Both loops effectively off: if this commits, it is because opening did.
      timings: { commitQuietMs: 60_000, healIntervalMs: 60_000, pullIntervalMs: 60_000 },
    })
    open.push(active)

    expect(await count(dir)).toBe(before + 1)
    expect((await active.repo.status()).dirty).toBe(false)
  })

  it('holds an oversized file out of the commit, keeping the tree clean', async () => {
    // Threshold 1 KB (via .holi/settings/app.yaml, read at open); a >1 KB file is
    // held back while the ordinary note (and the settings file itself) commit.
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    await mkdir(join(dir, '.holi/settings'), { recursive: true })
    await writeFile(join(dir, SETTINGS_FILE), '{"maxCommittedFileBytes": 1024}', 'utf8')
    await writeFile(join(dir, 'note.md'), 'a thought\n', 'utf8')
    await writeFile(join(dir, 'big.bin'), 'x'.repeat(2000), 'utf8')
    await sleep(QUIESCE)

    const held: HeldBackFile[][] = []
    const active = await openActiveVault({
      remote: 'syv-ai/notes',
      repo: openRepo(dir),
      onSnapshot: () => {},
      onSyncState: () => {},
      onHeldBack: (f) => held.push(f),
      // Loops off; if it commits, opening did. FR-7 aside, this pins the gate.
      timings: { commitQuietMs: 60_000, healIntervalMs: 60_000, pullIntervalMs: 60_000 },
    })
    open.push(active)

    // The note + settings landed; big.bin is held back, still on disk, and the
    // tree reads clean/up-to-date rather than perpetually dirty.
    expect((await active.repo.status()).dirtyPaths).toEqual(['big.bin'])
    expect(active.syncState()).toEqual({ kind: 'up-to-date' })
    expect(active.heldBack()).toEqual([{ path: 'big.bin', bytes: 2000 }])
    expect(held.at(-1)).toEqual([{ path: 'big.bin', bytes: 2000 }])
    await expect(readFile(join(dir, 'big.bin'), 'utf8')).resolves.toHaveLength(2000)
  })

  it('does not spin an empty commit when only held-back files remain', async () => {
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    await mkdir(join(dir, '.holi/settings'), { recursive: true })
    await writeFile(join(dir, SETTINGS_FILE), '{"maxCommittedFileBytes": 1024}', 'utf8')
    await writeFile(join(dir, 'big.bin'), 'x'.repeat(2000), 'utf8')
    await sleep(QUIESCE)

    const active = await openActiveVault({
      remote: 'syv-ai/notes',
      repo: openRepo(dir),
      onSnapshot: () => {},
      onSyncState: () => {},
      timings: { commitQuietMs: 60_000, healIntervalMs: 60_000, pullIntervalMs: 60_000 },
    })
    open.push(active)
    const after = await count(dir)

    // A forced commit with nothing but the held-back file left makes no commit.
    expect(await active.commitNow()).toBeNull()
    expect(await count(dir)).toBe(after)
  })

  it('commits nothing, and complains about nothing, when the tree is clean', async () => {
    // The normal outcome of an idle timer. `commitAll` returns null here and
    // that is not an error — logged as one, the console fills at 2 lines a
    // minute on a vault nobody is touching.
    const { dir } = await vault({ ...quick, healIntervalMs: 60 })
    const before = await count(dir)

    await sleep(SETTLE)
    expect(await count(dir)).toBe(before)
  })

  it('coalesces a burst into ONE commit', async () => {
    // FR-5: an agent turn touching ten files is one commit, not ten.
    const { dir } = await vault({ rescanDebounceMs: 30, commitQuietMs: 120 })
    const before = await count(dir)

    for (let i = 0; i < 10; i++) await writeFile(join(dir, `n${i}.md`), `${i}\n`, 'utf8')
    await waitFor('the coalesced commit', async () => (await count(dir)) > before)
    await sleep(SETTLE) // and then nothing further

    expect(await count(dir)).toBe(before + 1)
  })

  it('commits a file the watcher never reported', async () => {
    // Decision 8, and the test that would fail under a watcher-driven loop.
    // git status is the truth about what needs committing; the watcher only
    // decides how soon we ask. An uncommitted file breaks FR-7's clean tree,
    // and a tree that is not clean is one the next pull cannot merge.
    const { dir } = await vault({ rescanDebounceMs: 60_000, healIntervalMs: 80 })
    const before = await count(dir)

    await writeFile(join(dir, 'unseen.md'), 'nobody told us\n', 'utf8')
    await waitFor('the heal tick to commit it', async () => (await count(dir)) === before + 1)
  })

  it('names the file in the message when one file changed', async () => {
    const { dir } = await vault(quick)
    await writeFile(join(dir, 'roadmap.md'), 'plans\n', 'utf8')
    await waitFor('the commit', async () => (await subject(dir)) !== 'seed')

    expect(await subject(dir)).toBe('Update roadmap.md') // FR-4
  })

  it('names a count in the message when several changed', async () => {
    const { dir } = await vault({ rescanDebounceMs: 30, commitQuietMs: 120 })
    for (const n of ['a', 'b', 'c']) await writeFile(join(dir, `${n}.md`), `${n}\n`, 'utf8')
    await waitFor('the commit', async () => (await subject(dir)) !== 'seed')

    expect(await subject(dir)).toBe('Update 3 files')
  })

  it('commitNow() commits without waiting for the timer', async () => {
    // ⌘S. FR-4 calls it a real commit point, not a placebo.
    const { active, dir } = await vault({ commitQuietMs: 60_000, healIntervalMs: 60_000 })
    const before = await count(dir)

    await writeFile(join(dir, 'saved.md'), 'now\n', 'utf8')
    const sha = await active.commitNow()

    expect(sha).not.toBeNull()
    expect(await count(dir)).toBe(before + 1)
  })

  it('commitNow() returns null and commits nothing on a clean tree', async () => {
    const { active, dir } = await vault(quick)
    const before = await count(dir)
    expect(await active.commitNow()).toBeNull()
    expect(await count(dir)).toBe(before)
  })

  it('stops committing while paused, and resumes', async () => {
    // FR-8: autosave pauses during a reconcile, and while paused the vault
    // says so.
    const { active, dir } = await vault(quick)
    const before = await count(dir)

    active.pause('reconciling')
    await writeFile(join(dir, 'during.md'), 'x\n', 'utf8')
    await sleep(SETTLE)
    expect(await count(dir)).toBe(before)
    expect(active.syncState()).toEqual({ kind: 'paused', reason: 'reconciling', manual: true })

    active.resume()
    await writeFile(join(dir, 'after.md'), 'y\n', 'utf8')
    // Asserted on the OUTCOME rather than on a commit count: whether the work
    // held back during the pause and the work done after it coalesce into one
    // commit or land as two is a timing detail, and not what this test is about.
    await waitFor('the work to be committed after resuming', async () => {
      const tracked = await plainGit(dir, ['ls-tree', '-r', '--name-only', 'HEAD'])
      return tracked.includes('during.md') && tracked.includes('after.md')
    })
    expect((await active.repo.status()).dirty).toBe(false)
  })

  it('refuses to commit on a branch that is not the default one', async () => {
    // Decision 11 / FR-2. The vault stays open and readable — only sync stops.
    const { active, dir } = await vault(quick)
    await plainGit(dir, ['checkout', '-b', 'spike/idea'])
    const before = await count(dir)

    await writeFile(join(dir, 'on-a-branch.md'), 'x\n', 'utf8')
    await waitFor('sync to report itself paused', () => active.syncState().kind === 'paused')

    expect(await count(dir)).toBe(before)
    // Still open, still readable — FR-2 constrains sync, not open.
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe('# Vault\n')
    expect(active.snapshot().docs.length).toBeGreaterThan(0)
  })

  it('refuses to commit mid-merge', async () => {
    // A conflicted tree contains <<<<<<< markers and autosave would happily
    // commit them. This is also the state a reconcile runs inside.
    const origin = await makeRemote()
    const ours = await makeClone(origin)
    const theirs = await makeClone(origin, 'teammate')
    await writeFile(join(theirs, 'README.md'), '# Theirs\n', 'utf8')
    await plainGit(theirs, ['add', '-A'])
    await plainGit(theirs, ['commit', '-m', 'theirs'])
    await plainGit(theirs, ['push', 'origin', 'main'])
    await writeFile(join(ours, 'README.md'), '# Ours\n', 'utf8')
    await plainGit(ours, ['add', '-A'])
    await plainGit(ours, ['commit', '-m', 'ours'])
    await plainGit(ours, ['fetch', 'origin'])
    await plainGit(ours, ['merge', 'origin/main']).catch(() => {}) // conflicts
    await sleep(QUIESCE)

    const active = await openActiveVault({
      remote: 'syv-ai/notes',
      repo: openRepo(ours),
      onSnapshot: () => {},
      onSyncState: () => {},
      timings: quick,
    })
    open.push(active)
    const before = await count(ours)

    await writeFile(join(ours, 'during-merge.md'), 'x\n', 'utf8')
    await waitFor('sync to report itself paused', () => active.syncState().kind === 'paused')
    expect(await count(ours)).toBe(before)
  })

  it('commits in an unborn repo — the first autosave of a new vault', async () => {
    // Decision 11's exception. `github.createRepo` makes an empty repo, so the
    // clone has no commits at all, and its first autosave must land rather
    // than be mistaken for a broken checkout.
    const base = await tmp('holi-unborn-')
    const dir = join(base, 'fresh')
    await plainGit(base, ['init', '-b', 'main', dir])
    await plainGit(dir, ['config', 'user.name', 'Holi Test'])
    await plainGit(dir, ['config', 'user.email', 'test@holi.invalid'])
    await sleep(QUIESCE)

    const active = await openActiveVault({
      remote: 'syv-ai/fresh',
      repo: openRepo(dir),
      onSnapshot: () => {},
      onSyncState: () => {},
      timings: quick,
    })
    open.push(active)
    expect((await active.repo.status()).unborn).toBe(true)

    await writeFile(join(dir, 'first.md'), 'hello\n', 'utf8')
    await waitFor('the first commit of a brand-new vault', async () => {
      // `rev-list` fails outright on an unborn repo, so this cannot use count().
      return (await plainGit(dir, ['log', '--oneline']).catch(() => '')) !== ''
    })

    expect(await count(dir)).toBe(1)
  })
})

describe('ActiveVault — sync', () => {
  const count = async (dir: string) => Number(await plainGit(dir, ['rev-list', '--count', 'HEAD']))

  /** A vault plus a second clone of the same bare repo, playing the teammate. */
  async function withTeammate(timings?: Parameters<typeof openActiveVault>[0]['timings']) {
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    const teammate = await makeClone(origin, 'teammate')
    await sleep(QUIESCE)
    const snaps = snapshots()
    const active = await openActiveVault({
      remote: 'syv-ai/notes',
      repo: openRepo(dir),
      onSnapshot: snaps.push,
      onSyncState: () => {},
      // Pulling is off unless a test asks for it, so an unrelated fetch cannot
      // change the repo under an assertion.
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000, ...timings },
    })
    open.push(active)
    return { active, snaps, dir, teammate }
  }

  /**
   * A git command run by someone *else* against a repo Holi is also using.
   *
   * Retries on `index.lock`, because that is what the contention actually looks
   * like: Holi's loop holds the index for the length of a commit, and a command
   * arriving inside that window fails outright rather than waiting. This test
   * hit it about 40% of the time at an 80 ms heal interval.
   *
   * It is a real property of the design, not a test artifact — `vaults-sync.md`
   * makes the clone deliberately legible, and the agent has Bash. In production
   * the heal tick is 30 s and a commit is ~300 ms, so the window is small, but
   * it is not zero and a person who just wanted to switch branch would simply
   * try again. So does this.
   */
  async function userGit(dir: string, args: string[]): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await plainGit(dir, args)
        return
      } catch (err) {
        if (attempt >= 20 || !/index\.lock/.test(String(err))) throw err
        await sleep(50)
      }
    }
  }

  /** The teammate publishes. */
  async function theyPublish(teammate: string, rel: string, text: string) {
    await writeFile(join(teammate, rel), text, 'utf8')
    await plainGit(teammate, ['add', '-A'])
    await plainGit(teammate, ['commit', '-m', `write ${rel}`])
    await plainGit(teammate, ['push', 'origin', 'main'])
  }

  it('pulls on the interval, and the tree updates itself', async () => {
    // FR-9 and FR-11: a teammate's work arrives without anyone remembering
    // anything, and a clean merge is silent.
    const { active, dir, teammate } = await withTeammate({ pullIntervalMs: 80 })
    await theyPublish(teammate, 'theirs.md', 'their note\n')

    await waitFor(
      'their note to arrive',
      async () => (await readFile(join(dir, 'theirs.md'), 'utf8').catch(() => null)) !== null,
    )
    await waitFor('the tree to show it', () =>
      active.snapshot().docs.some((d) => d.path === 'theirs.md'),
    )
  })

  it('reports up-to-date when nothing has changed', async () => {
    const { active } = await withTeammate({ pullIntervalMs: 80 })
    await waitFor('a settled state', () => active.syncState().kind === 'up-to-date')
  })

  it('pushes a landed commit to the remote on the coalesce timer', async () => {
    // Push is automatic: a committed change reaches the remote without anyone
    // clicking anything (`prd/vaults-sync.md` §Pushing).
    const { active, dir, teammate } = await withTeammate({
      rescanDebounceMs: 30,
      commitQuietMs: 60,
      pushQuietMs: 120,
    })
    await writeFile(join(dir, 'mine.md'), 'auto-pushed\n', 'utf8')

    await waitFor('the commit to reach origin', async () => {
      await plainGit(teammate, ['fetch', 'origin'])
      const log = await plainGit(teammate, ['log', 'origin/main', '--oneline']).catch(() => '')
      return log.includes('mine.md')
    })
    await waitFor('the vault to settle up-to-date', () => active.syncState().kind === 'up-to-date')
  })

  it('shows offline with the waiting count when a push cannot reach the remote', async () => {
    // The one time unpushed commits are worth naming: the network is gone and
    // they are piling up. FR-22 forbids saying "synced" then, and a bare
    // "offline" hides how much is waiting.
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    await sleep(QUIESCE)
    const real = openRepo(dir)
    const active = await openActiveVault({
      remote: 'syv-ai/notes',
      repo: {
        ...real,
        status: async () => ({ ...(await real.status()), ahead: 2 }),
        push: async () => {
          throw new GitError('could not resolve host: github.com', 128, 'could not resolve host')
        },
      },
      onSnapshot: () => {},
      onSyncState: () => {},
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000 },
    })
    open.push(active)

    await active.pushNow()
    await waitFor(
      'offline with the waiting count',
      () => JSON.stringify(active.syncState()) === JSON.stringify({ kind: 'offline', count: 2 }),
    )
  })

  it('reports a permission rejection as no-access, not offline (FR-16)', async () => {
    // "You lost write access" and "you are offline" send someone to two
    // entirely different places, so they must never be the same word.
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    await sleep(QUIESCE)
    const real = openRepo(dir)
    const active = await openActiveVault({
      remote: 'syv-ai/notes',
      repo: {
        ...real,
        push: async () => ({ kind: 'rejected' as const, reason: 'permission' as const }),
      },
      onSnapshot: () => {},
      onSyncState: () => {},
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000 },
    })
    open.push(active)

    await active.pushNow()
    await waitFor('the no-access state', () => active.syncState().kind === 'no-access')
  })

  it('reports a conflict, leaves the tree clean, and stops retrying', async () => {
    // FR-12, and the most important assertion here. A conflicted tree contains
    // <<<<<<< markers and autosave would happily commit them, so the abort has
    // already run by the time the state changes. Auto-pull then pauses for this
    // vault, or it retries and re-aborts forever.
    const { active, dir, teammate } = await withTeammate({ pullIntervalMs: 80 })
    await theyPublish(teammate, 'README.md', '# Theirs\n')
    await writeFile(join(dir, 'README.md'), '# Ours\n', 'utf8')
    // Deliberately NOT committed here. The pull tick will land while the tree is
    // still dirty, which is the ordinary case — there is always an autosave
    // window — and the loop has to commit before merging. Getting this wrong
    // reports a conflict with an EMPTY path list, because `git merge` refuses
    // before starting and leaves no unmerged paths to name.
    await waitFor('the conflict to be reported', () => active.syncState().kind === 'conflict')
    expect(active.syncState()).toEqual({ kind: 'conflict', paths: ['README.md'] })

    const status = await active.repo.status()
    expect(status.merging).toBe(false)
    expect(status.dirty).toBe(false)
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe('# Ours\n')

    // And it does not keep trying: the state stays put across several intervals.
    await sleep(500)
    expect(active.syncState().kind).toBe('conflict')
  })

  it('reconcile() re-materialises the conflict in the tree for the agent', async () => {
    // FR-18 step 2: pull() aborted, so the tree is clean with a sticky banner.
    // reconcile() re-runs the merge so the agent has markers to resolve.
    const { active, dir, teammate } = await withTeammate({ pullIntervalMs: 80 })
    await theyPublish(teammate, 'README.md', '# Theirs\n')
    await writeFile(join(dir, 'README.md'), '# Ours\n', 'utf8')
    await waitFor('the conflict banner', () => active.syncState().kind === 'conflict')

    const { paths } = await active.reconcile()
    expect(paths).toEqual(['README.md'])
    expect((await active.repo.status()).merging).toBe(true)
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toContain('<<<<<<<')
  })

  it('reports a live reconcile as `reconciling`, naming the files being resolved', async () => {
    // FR-21's seventh state, and FR-19's input: while the agent works, the vault
    // is not merely "paused" — it is reconciling, and the editor needs the paths
    // to lock. A merge in progress is a `blockedReason`, so without this the
    // paths are lost behind a generic pause.
    const { active, dir, teammate } = await withTeammate({ pullIntervalMs: 80 })
    await theyPublish(teammate, 'README.md', '# Theirs\n')
    await writeFile(join(dir, 'README.md'), '# Ours\n', 'utf8')
    await waitFor('the conflict banner', () => active.syncState().kind === 'conflict')

    await active.reconcile()
    expect(active.syncState()).toEqual({ kind: 'reconciling', paths: ['README.md'] })
  })

  it('calls a merge nobody asked Holi for `paused`, not `reconciling`', async () => {
    // The distinction the state rests on. Someone merging in a terminal is a
    // vault Holi must not touch (FR-2), not a reconcile in progress — and the
    // editor must not lock their files on the strength of it.
    const { active, dir, teammate } = await withTeammate({
      pullIntervalMs: 80,
      healIntervalMs: 120,
    })
    await theyPublish(teammate, 'README.md', '# Theirs\n')
    await writeFile(join(dir, 'README.md'), '# Ours\n', 'utf8')
    await waitFor('the conflict banner', () => active.syncState().kind === 'conflict')

    // Their own merge, by hand, outside anything Holi initiated.
    await userGit(dir, ['fetch', 'origin']).catch(() => {})
    await userGit(dir, ['merge', 'origin/main']).catch(() => {})
    await waitFor('the merge to be in the tree', async () => (await active.repo.status()).merging)

    await waitFor('the pause', () => active.syncState().kind === 'paused')
    expect(active.syncState().kind).toBe('paused')
  })

  it('ends the reconcile by itself when the agent finishes the merge', async () => {
    // FR-18(d): "resumes normal operation once the tree is clean". Nobody tells
    // Holi the agent is done — the merge commit is the signal, and until it is
    // read the vault stays latched with autosave and auto-pull off.
    const { active, dir, teammate } = await withTeammate({
      pullIntervalMs: 80,
      healIntervalMs: 120,
      rescanDebounceMs: 30,
      commitQuietMs: 60,
    })
    await theyPublish(teammate, 'README.md', '# Theirs\n')
    await writeFile(join(dir, 'README.md'), '# Ours\n', 'utf8')
    await waitFor('the conflict banner', () => active.syncState().kind === 'conflict')
    await active.reconcile()
    expect(active.syncState().kind).toBe('reconciling')

    // What the agent does: resolve the markers, stage, finish the merge.
    await writeFile(join(dir, 'README.md'), '# Ours and Theirs\n', 'utf8')
    await userGit(dir, ['add', '-A'])
    await userGit(dir, ['commit', '--no-edit'])

    await waitFor('the reconcile to end', () => active.syncState().kind !== 'reconciling')
    expect(active.syncState().kind).not.toBe('conflict')
  })

  it('commits again once the reconcile is over', async () => {
    // The other half of "resumes normal operation": the state going quiet is
    // worth nothing if autosave stays off. FR-8 pauses it for the reconcile;
    // this is the resume.
    const { active, dir, teammate } = await withTeammate({
      pullIntervalMs: 80,
      healIntervalMs: 120,
      rescanDebounceMs: 30,
      commitQuietMs: 60,
    })
    await theyPublish(teammate, 'README.md', '# Theirs\n')
    await writeFile(join(dir, 'README.md'), '# Ours\n', 'utf8')
    await waitFor('the conflict banner', () => active.syncState().kind === 'conflict')
    await active.reconcile()

    await writeFile(join(dir, 'README.md'), '# Ours and Theirs\n', 'utf8')
    await userGit(dir, ['add', '-A'])
    await userGit(dir, ['commit', '--no-edit'])
    await waitFor('the reconcile to end', () => active.syncState().kind !== 'reconciling')

    // An ordinary edit afterwards, which only autosave can land.
    await writeFile(join(dir, 'notes.md'), '# After\n', 'utf8')
    await waitFor('the autosave commit', async () => !(await active.repo.status()).dirty)
  })

  it('abandon() takes the merge back out of the tree and restores the banner', async () => {
    // FR-20. The pre-reconcile state is a clean tree with a conflict still
    // waiting, so that is what abandoning returns to — not "nothing is wrong",
    // which would lose the teammate's change, and not a second reconcile.
    const { active, dir, teammate } = await withTeammate({ pullIntervalMs: 80 })
    await theyPublish(teammate, 'README.md', '# Theirs\n')
    await writeFile(join(dir, 'README.md'), '# Ours\n', 'utf8')
    await waitFor('the conflict banner', () => active.syncState().kind === 'conflict')
    await active.reconcile()
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toContain('<<<<<<<')

    await active.abandon()

    expect((await active.repo.status()).merging).toBe(false)
    expect(await readFile(join(dir, 'README.md'), 'utf8')).not.toContain('<<<<<<<')
    expect(active.syncState()).toEqual({ kind: 'conflict', paths: ['README.md'] })
  })

  it('survives the agent turn ending — a turn is not the reconcile', async () => {
    // Git coexistence pauses the vault for the assistant's turn and `resume()`
    // lifts it, clearing the sticky conflict pause on the way out (FR-12's
    // escape). A reconcile runs *through* the agent, so its first turn ending
    // must not be read as the merge being done — the markers are still there.
    const { active, dir, teammate } = await withTeammate({ pullIntervalMs: 80 })
    await theyPublish(teammate, 'README.md', '# Theirs\n')
    await writeFile(join(dir, 'README.md'), '# Ours\n', 'utf8')
    await waitFor('the conflict banner', () => active.syncState().kind === 'conflict')
    await active.reconcile()

    active.pause('the assistant is working')
    active.resume()
    // `resume()` kicks the commit and pull loops, both of which recompute the
    // state — SETTLE is long enough that a wrong answer has landed by now.
    await sleep(SETTLE)

    expect(active.syncState()).toEqual({ kind: 'reconciling', paths: ['README.md'] })
  })

  it('reconcile() clears the banner when the merge now applies cleanly', async () => {
    // The conflict resolved itself before the user clicked (both sides ended up
    // making the same edit). reconcile() must not strand a stale banner.
    const { active, dir, teammate } = await withTeammate({ pullIntervalMs: 80 })
    await theyPublish(teammate, 'README.md', '# Theirs\n')
    await writeFile(join(dir, 'README.md'), '# Ours\n', 'utf8')
    await waitFor('the conflict banner', () => active.syncState().kind === 'conflict')

    // Make our side match theirs, so the re-merge applies cleanly (identical
    // changes merge without conflict). The tree is clean here (the conflict path
    // committed "# Ours" before aborting); retry on the loop's index lock.
    await writeFile(join(dir, 'README.md'), '# Theirs\n', 'utf8')
    await userGit(dir, ['add', '-A'])
    await userGit(dir, ['commit', '-m', 'match theirs'])

    const { paths } = await active.reconcile()
    expect(paths).toEqual([])
    expect(active.syncState().kind).not.toBe('conflict')
    expect((await active.repo.status()).merging).toBe(false)
  })

  it('keeps committing while a conflict banner is up', async () => {
    // FR-17: the banner is non-blocking — ignore it and you keep working on an
    // unbroken vault. Only a reconcile (FR-8) pauses autosave.
    const { active, dir, teammate } = await withTeammate({
      pullIntervalMs: 80,
      rescanDebounceMs: 30,
      commitQuietMs: 60,
    })
    await theyPublish(teammate, 'README.md', '# Theirs\n')
    await writeFile(join(dir, 'README.md'), '# Ours\n', 'utf8')
    // Let the vault's own autosave commit our side rather than racing it with a
    // manual `git commit` — with a fast heal tick it wins, and the test's commit
    // then fails with "nothing to commit". Waiting for a clean tree is both
    // deterministic and closer to what actually happens.
    await waitFor('our edit to be autosaved', async () => !(await active.repo.status()).dirty)
    // The auto-pull loop reaches the divergence and reports the conflict itself.
    await waitFor('the conflict banner', () => active.syncState().kind === 'conflict')

    const before = await count(dir)
    await writeFile(join(dir, 'carrying-on.md'), 'still working\n', 'utf8')
    await waitFor('a commit despite the banner', async () => (await count(dir)) === before + 1)
    // The banner survives the commit rather than being overwritten by it.
    expect(active.syncState().kind).toBe('conflict')
  })

  it('reports the pause, not the conflict, when a conflicted vault goes off-branch', async () => {
    // Found by running the app. Both facts are true at once and only one state
    // can be shown; the pause is the one that costs something to miss, because
    // it means autosave is off and edits are piling up uncommitted while the
    // indicator implies they are safe. The conflict is still there — and shown
    // again — the moment the branch comes back.
    // Auto-pull stays OFF and the conflict is established with an explicit
    // pushNow(), whose non-fast-forward recovery pulls and hits exactly the same
    // conflict path. Racing an 80 ms pull interval against the test's own git
    // guarantees index.lock collisions — the vault's `git merge` and the test's
    // `git checkout` cannot both hold the index — and that contention is the
    // subject of a different finding, not of this test.
    // BOTH background loops are off and every step is driven explicitly.
    // commitNow() forces the fresh status read this test is about.
    const { active, dir, teammate } = await withTeammate({
      pullIntervalMs: 60_000,
      healIntervalMs: 60_000,
      commitQuietMs: 60_000,
    })
    await theyPublish(teammate, 'README.md', '# Theirs\n')
    await writeFile(join(dir, 'README.md'), '# Ours\n', 'utf8')
    await active.commitNow()
    await active.pushNow()
    expect(active.syncState().kind).toBe('conflict')

    await plainGit(dir, ['checkout', '-b', 'spike/idea'])
    await active.commitNow()
    expect(active.syncState().kind).toBe('paused')
    expect((active.syncState() as { reason: string }).reason).toContain('spike/idea')

    await plainGit(dir, ['checkout', 'main'])
    await active.commitNow()
    expect(active.syncState().kind).toBe('conflict')
  })

  it('resume() clears the conflict and lets auto-pull start again', async () => {
    // FR-18: a reconcile "resumes normal operation once the tree is clean".
    // Found by running the app: FR-12's pause is sticky by design, so if
    // nothing ever clears it the vault is stranded — the banner stays up
    // forever and no pull is ever attempted again, even after the conflict has
    // actually been resolved. resume() is the only way back, so it has to
    // clear BOTH pauses, not just the manual one.
    // Every git call here goes through `userGit`, because that is what it is:
    // a second process acting on a repo Holi is also using. With the loop at
    // 80 ms these collide on `index.lock` often enough to flake ~1 run in 3.
    // Same reasoning as the test above: the conflict is established with an
    // explicit pushNow() so the loop is not running git while the test is.
    const { active, dir, teammate } = await withTeammate({
      pullIntervalMs: 60_000,
      healIntervalMs: 60_000,
      commitQuietMs: 60_000,
      // Unthrottled, because the final step drives focus in a loop. A single
      // onFocus() is not enough: if one lands while resume()'s own pull is
      // still in flight, the in-flight guard drops it — and the throttle window
      // has already been spent. That is a real (small) wrinkle in the product
      // too, noted in the plan's open questions rather than papered over here.
      focusThrottleMs: 0,
    })
    await theyPublish(teammate, 'README.md', '# Theirs\n')
    await writeFile(join(dir, 'README.md'), '# Ours\n', 'utf8')
    await active.commitNow()
    await active.pushNow()
    expect(active.syncState().kind).toBe('conflict')

    // Resolve it the way a developer would, in a terminal.
    await plainGit(dir, ['fetch', 'origin'])
    await plainGit(dir, ['merge', '-X', 'ours', 'origin/main'])

    // Until resume(), the vault is stranded: it will never look again.
    await sleep(300)
    expect(active.syncState().kind).toBe('conflict')

    active.resume()
    await waitFor('sync to recover', () => active.syncState().kind !== 'conflict')

    // And it really is syncing again, not just displaying differently. The
    // interval is off in this test, so the next pull is driven by focus —
    // which is itself the FR-9 trigger, and would equally have been refused
    // while the conflict pause was still latched.
    await theyPublish(teammate, 'after-recovery.md', 'arrived\n')
    await waitFor('a pull after recovering', async () => {
      active.onFocus()
      return (await readFile(join(dir, 'after-recovery.md'), 'utf8').catch(() => null)) !== null
    })
  })

  it('recovers from a non-fast-forward push by pulling then retrying', async () => {
    // The remote moved under us. Rather than surface a rejection, pushNow pulls
    // and retries — both sides survive (`prd/vaults-sync.md` §Pushing). A push
    // rejection is just one more way to discover a divergence.
    const { active, dir, teammate } = await withTeammate()
    await theyPublish(teammate, 'theirs.md', 'theirs\n')
    await writeFile(join(dir, 'mine.md'), 'mine\n', 'utf8')
    await active.commitNow()

    await active.pushNow()

    expect(active.syncState().kind).toBe('up-to-date')
    await plainGit(teammate, ['pull', 'origin', 'main'])
    expect(await readFile(join(teammate, 'mine.md'), 'utf8')).toBe('mine\n')
    expect(await readFile(join(dir, 'theirs.md'), 'utf8')).toBe('theirs\n')
  })

  it('does not call a lost index.lock "offline"', async () => {
    // Every failure inside the pull lands in one catch, and that catch says
    // offline — right for a laptop on a plane, wrong for a lock the user's own
    // git held for 200 ms. FR-16 makes the same point about push: a permission
    // failure must never be confused with a network one, and the inverse is
    // just as bad. Telling someone their vault is offline sends them to look at
    // their wifi for a problem that is already over.
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    await sleep(QUIESCE)
    const real = openRepo(dir)
    let pulls = 0
    const active = await openActiveVault({
      remote: 'syv-ai/notes',
      repo: {
        ...real,
        pull: async () => {
          pulls += 1
          throw new GitError(
            'git merge failed (128): fatal: Unable to create index.lock: File exists.',
            128,
            "fatal: Unable to create '/x/.git/index.lock': File exists.\n",
          )
        },
      },
      onSnapshot: () => {},
      onSyncState: () => {},
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000 },
    })
    open.push(active)

    active.onFocus()
    // Both waits matter: the first proves the failing pull really happened, so
    // the assertion cannot pass by never having pulled at all.
    await waitFor('the pull to fail', () => pulls === 1)
    await waitFor('the state to settle after it', () => active.syncState().kind !== 'pulling')

    expect(active.syncState().kind).not.toBe('offline')
  })

  it('a focus arriving during a pull does not spend the throttle window', async () => {
    // `onFocus` stamped the throttle and only then hit `maybePull`'s in-flight
    // guard, so a focus that achieved nothing still bought 30 s of silence —
    // and FR-9's "on window focus" quietly stopped holding for the next
    // alt-tab, which is the one the user is waiting on.
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    await sleep(QUIESCE)
    const real = openRepo(dir)
    let pulls = 0
    let release = () => {}
    const firstPullHangs = new Promise<void>((r) => (release = r))
    const active = await openActiveVault({
      remote: 'syv-ai/notes',
      repo: {
        ...real,
        pull: async () => {
          pulls += 1
          if (pulls === 1) await firstPullHangs
          return { kind: 'up-to-date' as const }
        },
      },
      onSnapshot: () => {},
      onSyncState: () => {},
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000, focusThrottleMs: 300 },
    })
    open.push(active)

    active.onFocus()
    await waitFor('the first pull to start', () => pulls === 1)
    // Past the throttle, so this focus is entitled to a pull — and cannot have
    // one, because the first is still fetching.
    await sleep(400)
    active.onFocus()

    release()
    await waitFor('the first pull to finish', () => active.syncState().kind !== 'pulling')
    active.onFocus()

    // Short, and deliberately shorter than the throttle: with the bug the
    // window has been spent and no amount of waiting produces a second pull.
    await waitFor('a pull on the focus after the fetch', () => pulls === 2, 250)
  })

  it('does not strand the vault when a push-recovery pull conflicts but names no paths', async () => {
    // A non-fast-forward push triggers a recovery pull; when that merge is
    // refused before it starts — a tree that went dirty, an index.lock lost to
    // the user's own git — it comes back naming nothing. `maybePull` already
    // refuses to latch FR-12's sticky pause on that, and pushNow inherits it by
    // delegating: otherwise one transient race would disable auto-pull forever.
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    const teammate = await makeClone(origin, 'teammate')
    await sleep(QUIESCE)
    const real = openRepo(dir)
    // The push stays rejected non-fast-forward; the FIRST recovery pull names no
    // paths (the transient race), later pulls are real so the vault can recover.
    let pulls = 0
    const active = await openActiveVault({
      remote: 'syv-ai/notes',
      repo: {
        ...real,
        push: async () => ({ kind: 'rejected' as const, reason: 'non-fast-forward' as const }),
        pull: async () => {
          pulls += 1
          if (pulls === 1) return { kind: 'conflict' as const, paths: [] }
          return real.pull()
        },
      },
      onSnapshot: () => {},
      onSyncState: () => {},
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000 },
    })
    open.push(active)

    await active.pushNow()
    expect(active.syncState().kind).not.toBe('conflict')

    // The harm is not the banner, it is that auto-pull never runs again.
    await theyPublish(teammate, 'after-the-race.md', 'arrived\n')
    await waitFor('a pull after the empty conflict', async () => {
      active.onFocus()
      return (await readFile(join(dir, 'after-the-race.md'), 'utf8').catch(() => null)) !== null
    })
  })

  it('reports a real conflict during a push recovery and pushes nothing', async () => {
    // FR-15 preserved: the user's work stays local and intact, the remote is
    // untouched, and the tree is left clean for the reconcile path.
    const { active, dir, teammate } = await withTeammate()
    await theyPublish(teammate, 'README.md', '# Theirs\n')
    await writeFile(join(dir, 'README.md'), '# Ours\n', 'utf8')
    await active.commitNow()

    await active.pushNow()
    expect(active.syncState()).toEqual({ kind: 'conflict', paths: ['README.md'] })
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe('# Ours\n')
    expect((await active.repo.status()).merging).toBe(false)
  })

  it('pulls on window focus', async () => {
    // FR-9. Focus is the trigger that makes the interval nearly irrelevant.
    const { active, dir, teammate } = await withTeammate()
    await theyPublish(teammate, 'focus.md', 'arrived\n')

    active.onFocus()
    await waitFor(
      'the focus pull',
      async () => (await readFile(join(dir, 'focus.md'), 'utf8').catch(() => null)) !== null,
    )
  })

  it('throttles focus so alt-tabbing does not fetch in a loop', async () => {
    const { active, dir, teammate } = await withTeammate({ focusThrottleMs: 60_000 })

    // Wait on the ARRIVAL of a real file rather than on a state, because
    // `up-to-date` is also the state the vault opens in — the first focus pull
    // would otherwise be considered finished before it had started.
    await theyPublish(teammate, 'early.md', 'arrives\n')
    active.onFocus()
    await waitFor(
      'the first focus pull to complete',
      async () => (await readFile(join(dir, 'early.md'), 'utf8').catch(() => null)) !== null,
    )

    // Publish AFTER that pull, then focus again inside the throttle window.
    await theyPublish(teammate, 'late.md', 'should not arrive yet\n')
    active.onFocus()
    await sleep(SETTLE)

    expect(await readFile(join(dir, 'late.md'), 'utf8').catch(() => null)).toBeNull()
  })

  it('does not pull a vault opened on a branch that is not the default one', async () => {
    // The branch is switched BEFORE the vault opens, which is the state FR-2
    // actually describes ("if the clone is on another branch ... on open").
    //
    // Switching *while* a pull is already in flight is a different and much
    // narrower thing: the pull is authorised against a status read moments
    // earlier, so a checkout landing inside that window merges onto the new
    // branch. In production that needs a branch switch inside roughly a second
    // of a three-minute interval, and `git.ts` merges rather than resets, so
    // the cost is a merge commit somewhere unexpected and not lost work.
    // Asserting the no-merge property here would be asserting the absence of
    // that race, which is not what this requirement is about.
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    const teammate = await makeClone(origin, 'teammate')
    await plainGit(dir, ['checkout', '-b', 'spike/idea'])
    await sleep(QUIESCE)

    const active = await openActiveVault({
      remote: 'syv-ai/notes',
      repo: openRepo(dir),
      onSnapshot: () => {},
      onSyncState: () => {},
      timings: { pullIntervalMs: 80, healIntervalMs: 60_000 },
    })
    open.push(active)
    await theyPublish(teammate, 'theirs.md', 'theirs\n')

    await waitFor('sync to report itself paused', () => active.syncState().kind === 'paused')
    await sleep(400)
    expect(await readFile(join(dir, 'theirs.md'), 'utf8').catch(() => null)).toBeNull()
  })

  it('pauses when the branch changes under an open vault, and resumes on the way back', async () => {
    // Decision 11: the FR-2 refusal is derived fresh from `git status` rather
    // than latched, so it clears itself when the user switches back instead of
    // needing anyone to notice.
    const { active, dir } = await withTeammate({ pullIntervalMs: 60_000, healIntervalMs: 80 })

    await userGit(dir, ['checkout', '-b', 'spike/idea'])
    await waitFor('the pause', () => active.syncState().kind === 'paused')
    expect((active.syncState() as { reason: string }).reason).toContain('spike/idea')

    await userGit(dir, ['checkout', 'main'])
    await waitFor('sync to resume by itself', () => active.syncState().kind !== 'paused')
  })

  it('survives overlapping pull ticks', async () => {
    // A pull slower than the interval must not start a second one on top of
    // itself. Driven by an interval far shorter than a fetch takes.
    const { active, dir, teammate } = await withTeammate({ pullIntervalMs: 10 })
    await theyPublish(teammate, 'theirs.md', 'theirs\n')

    await waitFor(
      'their note, exactly once',
      async () => (await readFile(join(dir, 'theirs.md'), 'utf8').catch(() => null)) !== null,
    )
    await waitFor('a settled state', () => active.syncState().kind === 'up-to-date')
    expect((await active.repo.status()).merging).toBe(false)
  })
})

describe('VaultHost', () => {
  /** A registry holding two vaults, both real clones. */
  async function twoVaults() {
    const registry = new VaultRegistry(join(await tmp('holi-reg-'), 'vaults.json'))
    const a = await makeClone(await makeRemote(), 'vault-a')
    const b = await makeClone(await makeRemote(), 'vault-b')
    const at = '2026-07-22T10:00:00Z'
    await registry.add({ remote: 'syv-ai/a', path: a, name: 'a', lastOpenedAt: at })
    await registry.add({ remote: 'syv-ai/b', path: b, name: 'b', lastOpenedAt: at })
    await sleep(QUIESCE)
    return { registry, a, b }
  }

  const hosts: VaultHost[] = []
  afterEach(async () => {
    for (const h of hosts.splice(0)) await h.close().catch(() => {})
  })

  function host(registry: VaultRegistry, timings: Partial<SyncTimings> = {}) {
    const snaps = snapshots()
    const h = createVaultHost({
      registry,
      onSnapshot: snaps.push,
      onSyncState: () => {},
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000, ...timings },
    })
    hosts.push(h)
    return { h, snaps }
  }

  /**
   * Opening a vault must ANNOUNCE its sync state, even when that state is the
   * boring one.
   *
   * `setState` only pushes on a change, and a fresh `ActiveVault` starts its
   * local `state` at `up-to-date` — so opening a clean vault decided nothing had
   * changed and pushed nothing at all. The renderer holds one sync state for the
   * whole app, so it kept displaying the *previous* vault's: switching from a
   * vault stuck offline to an empty one still read the offline count from the
   * one before it. FR-22 is that the indicator must never claim a state that is
   * not true, and that cuts both ways.
   */
  it('announces the opening sync state, even when nothing changed', async () => {
    const { registry } = await twoVaults()
    const seen: string[] = []
    const h = createVaultHost({
      registry,
      onSnapshot: () => {},
      onSyncState: (s) => seen.push(s.kind),
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000 },
    })
    hosts.push(h)

    await h.open('syv-ai/a')
    expect(seen).toContain('up-to-date')
  })

  it('forwards the held-back set from the opened vault to onHeldBack', async () => {
    const { registry, a } = await twoVaults()
    await mkdir(join(a, '.holi/settings'), { recursive: true })
    await writeFile(join(a, SETTINGS_FILE), '{"maxCommittedFileBytes": 1024}', 'utf8')
    await writeFile(join(a, 'big.bin'), 'x'.repeat(2000), 'utf8')
    await sleep(QUIESCE)

    const held: HeldBackFile[][] = []
    const h = createVaultHost({
      registry,
      onSnapshot: () => {},
      onSyncState: () => {},
      onHeldBack: (f) => held.push(f),
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000 },
    })
    hosts.push(h)

    await h.open('syv-ai/a')
    expect(held.at(-1)).toEqual([{ path: 'big.bin', bytes: 2000 }])
  })

  it('opens a vault and makes it active', async () => {
    const { registry } = await twoVaults()
    const { h } = host(registry)

    const vault = await h.open('syv-ai/a')
    expect(h.active()).toBe(vault)
    expect(vault.remote).toBe('syv-ai/a')
    expect(vault.snapshot().docs.map((d) => d.path)).toEqual(['README.md'])
  })

  it('tears the previous vault down when switching', async () => {
    // Decision 2's entire content: exactly one watcher and one set of timers
    // exist at a time, so a switch is a teardown rather than a leak.
    const { registry, a } = await twoVaults()
    const { h, snaps } = host(registry, { rescanDebounceMs: 30 })

    await h.open('syv-ai/a')
    await h.open('syv-ai/b')
    const before = snaps.count

    // The first vault's watcher must be gone: writing into it pushes nothing.
    await writeFile(join(a, 'orphan.md'), 'nobody is listening\n', 'utf8')
    await sleep(SETTLE)

    expect(snaps.count).toBe(before)
    expect(h.active()?.remote).toBe('syv-ai/b')
  })

  it('lets go of what was running against a vault BEFORE it closes', async () => {
    // The agent's sessions (D100). A session teardown resumes the vault's sync
    // loop and may take a settle commit, so it has to run while the vault it
    // ran in is still the active one — not after the switch has moved on.
    const { registry } = await twoVaults()
    const leftFrom: Array<string | null> = []
    const h = createVaultHost({
      registry,
      onSnapshot: () => {},
      onSyncState: () => {},
      onLeave: async () => {
        leftFrom.push(h.active()?.remote ?? null)
      },
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000 },
    })
    hosts.push(h)

    await h.open('syv-ai/a')
    expect(leftFrom).toEqual([]) // nothing to leave yet
    await h.open('syv-ai/b')
    expect(leftFrom).toEqual(['syv-ai/a'])

    // Re-opening the vault that is already open is the renderer asking for a
    // fresh picture, not a switch: a session must survive it.
    await h.open('syv-ai/b')
    expect(leftFrom).toEqual(['syv-ai/a'])

    await h.close()
    expect(leftFrom).toEqual(['syv-ai/a', 'syv-ai/b'])
  })

  it('switches vaults even when the leave hook throws', async () => {
    const { registry } = await twoVaults()
    const h = createVaultHost({
      registry,
      onSnapshot: () => {},
      onSyncState: () => {},
      onLeave: () => Promise.reject(new Error('the PTY would not die')),
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000 },
    })
    hosts.push(h)

    await h.open('syv-ai/a')
    await h.open('syv-ai/b')
    expect(h.active()?.remote).toBe('syv-ai/b')
  })

  it('commits a dirty vault before switching away from it', async () => {
    // FR-6: work is flushed and committed on a vault switch. A tree left dirty
    // is one the next pull cannot merge — and nothing is watching it any more
    // to notice.
    const { registry, a } = await twoVaults()
    const { h } = host(registry, { commitQuietMs: 60_000 })

    await h.open('syv-ai/a')
    await writeFile(join(a, 'unsaved.md'), 'mid-sentence\n', 'utf8')
    await h.open('syv-ai/b')

    expect(await plainGit(a, ['log', '-1', '--format=%s'])).toBe('Update unsaved.md')
    expect(await plainGit(a, ['status', '--porcelain'])).toBe('')
  })

  it('is idempotent for the vault already open', async () => {
    const { registry } = await twoVaults()
    const { h } = host(registry)

    const first = await h.open('syv-ai/a')
    expect(await h.open('syv-ai/a')).toBe(first)
  })

  it('refuses a remote that is not registered', async () => {
    const { registry } = await twoVaults()
    const { h } = host(registry)
    await expect(h.open('someone/unknown')).rejects.toThrow(/someone\/unknown/)
  })

  it('leaves nothing running after close()', async () => {
    const { registry, a } = await twoVaults()
    const { h, snaps } = host(registry, { rescanDebounceMs: 30, healIntervalMs: 50 })

    await h.open('syv-ai/a')
    await h.close()
    const before = snaps.count

    await writeFile(join(a, 'after.md'), 'too late\n', 'utf8')
    await sleep(SETTLE)

    expect(snaps.count).toBe(before)
    expect(h.active()).toBeNull()
  })

  it('serialises concurrent opens rather than racing two vaults into one slot', async () => {
    // Two clicks in the switcher, or a click during a slow open. Unserialised,
    // both openActiveVault calls run and only one is ever closed — leaking the
    // other's watcher and timers for the life of the process.
    const { registry } = await twoVaults()
    const { h } = host(registry)

    await Promise.all([h.open('syv-ai/a'), h.open('syv-ai/b')])
    expect(h.active()?.remote).toBe('syv-ai/b')
  })
})
