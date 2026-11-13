import { SETTINGS_FILE, syncLabel, type VaultSnapshot } from '@holi/shared'
import { taskClaim } from '@holi/shared'
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
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitError, openRepo } from '../src/main/git'
import * as vaultWatcher from '../src/main/vault/watcher'
import * as vaultStore from '../src/main/vault/vault-store'
import { HELD_BACK_FILE, type HeldBackFile } from '../src/main/vault/large-files'
import {
  createVaultHost,
  openActiveVault,
  SYNC_ALERT_FAILURES,
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
  timeoutMs = 15_000,
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
  await cleanupFixtures()
})

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
type VaultSnapshotLike = {
  docs: { path: string }[]
  claimed: Record<string, { items: { path: string }[] }>
}

/** Tasks, still a core claim: what the scanner claims in every vault here. */
const CLAIMS = async () => [{ ...taskClaim, plugin: 'tasks' }]

const paths = (s: VaultSnapshotLike) => s.docs.map((d) => d.path).sort()

async function vault(timings?: Parameters<typeof openActiveVault>[0]['timings']) {
  const origin = await makeRemote()
  const dir = await makeClone(origin)
  await sleep(QUIESCE)
  const snaps = snapshots()
  const committed: (string[] | null)[] = []
  const active = await openActiveVault({
    claims: CLAIMS,
    remote: 'syv-ai/notes',
    repo: openRepo(dir),
    onSnapshot: snaps.push,
    onSyncState: () => {},
    onCommitted: (paths) => committed.push(paths),
    timings,
  })
  open.push(active)
  return { active, snaps, dir, origin, committed }
}

describe('ActiveVault — snapshot', () => {
  it('drains a failed held-back override before commitNow returns', async () => {
    const { active, dir } = await vault({
      rescanDebounceMs: 60_000,
      commitQuietMs: 60_000,
      healIntervalMs: 60_000,
      pullIntervalMs: 60_000,
    })
    await writeFile(join(dir, 'large.bin'), Buffer.alloc(10 * 1024 * 1024 + 1))
    await active.commitNow()
    await waitFor('the file to be held back', () =>
      active.heldBack().some((file) => file.path === 'large.bin'),
    )

    let release!: () => void
    let entered!: () => void
    const insideCommit = new Promise<void>((resolve) => (entered = resolve))
    const blocked = new Promise<void>((resolve) => (release = resolve))
    const commit = vi.spyOn(active.repo, 'commitFileNoVerify').mockImplementation(async () => {
      entered()
      await blocked
      throw new Error('override failed')
    })
    const override = active.commitHeldBack('large.bin')
    await insideCommit

    let drained = false
    const drain = active.commitNow().then((sha) => {
      drained = true
      return sha
    })
    await sleep(100)
    expect(drained).toBe(false)

    release()
    await expect(override).rejects.toThrow('override failed')
    expect(await drain).not.toBe('busy')
    commit.mockRestore()
  })

  it('commits an override through history events and the scheduled remote push', async () => {
    const { active, dir, origin, committed } = await vault({
      rescanDebounceMs: 60_000,
      commitQuietMs: 60_000,
      healIntervalMs: 60_000,
      pullIntervalMs: 60_000,
      pushQuietMs: 100,
    })
    await writeFile(join(dir, 'large.bin'), Buffer.alloc(10 * 1024 * 1024 + 1))
    await active.commitNow()
    await waitFor('the file to be held back', () =>
      active.heldBack().some((file) => file.path === 'large.bin'),
    )

    await active.commitHeldBack('large.bin')

    expect(committed).toContainEqual(['large.bin'])
    await waitFor('the scheduled push', async () => {
      const remote = await plainGit(origin, ['rev-parse', 'refs/heads/main']).catch(() => '')
      return remote !== '' && remote === (await active.repo.head())
    })
    expect(await plainGit(origin, ['cat-file', '-s', 'HEAD:large.bin'])).toBe(
      String(10 * 1024 * 1024 + 1),
    )
  })

  it('scans on open, before any event fires', async () => {
    const { active } = await vault()
    expect(paths(active.snapshot())).toEqual(['README.md'])
  })

  it('rescans and autosaves a note created between the opening scan and watcher readiness', async () => {
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    await sleep(QUIESCE)
    const snaps = snapshots()
    const before = Number(await plainGit(dir, ['rev-list', '--count', 'HEAD']))
    const actualWatchVault = vaultWatcher.watchVault
    const watchSpy = vi.spyOn(vaultWatcher, 'watchVault').mockImplementation(async (args) => {
      // watchVault is reached only after openActiveVault's opening scan. Write
      // before the watcher is constructed so the note is in the precise gap
      // that the post-readiness rescan must close.
      await writeFile(join(dir, 'between-scan-and-watch.md'), '# Between\n', 'utf8')
      return actualWatchVault(args)
    })
    const active = await openActiveVault({
      claims: CLAIMS,
      remote: 'syv-ai/notes',
      repo: openRepo(dir),
      onSnapshot: snaps.push,
      onSyncState: () => {},
      // No heal tick can rescue a missed opening note during this test.
      timings: {
        rescanDebounceMs: 60_000,
        commitQuietMs: 100,
        healIntervalMs: 60_000,
        pullIntervalMs: 60_000,
      },
    })
    open.push(active)
    watchSpy.mockRestore()

    await waitFor('the post-readiness opening snapshot', () =>
      paths(active.snapshot()).includes('between-scan-and-watch.md'),
    )
    await waitFor(
      'the opening autosave commit',
      async () => Number(await plainGit(dir, ['rev-list', '--count', 'HEAD'])) === before + 1,
    )

    expect(paths(snaps.last)).toContain('between-scan-and-watch.md')
    expect((await active.repo.status()).dirty).toBe(false)
  })

  it('rescans after a watcher event arrives during the opening rescan', async () => {
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    await sleep(QUIESCE)
    const snaps = snapshots()
    const actualWatchVault = vaultWatcher.watchVault
    let onChange: (() => void) | undefined
    const watchSpy = vi.spyOn(vaultWatcher, 'watchVault').mockImplementation(async (args) => {
      onChange = args.onChange
      return actualWatchVault(args)
    })
    const actualScan = vaultStore.scanVault
    let releaseScan!: () => void
    let scanStarted!: () => void
    const started = new Promise<void>((resolve) => (scanStarted = resolve))
    const blocked = new Promise<void>((resolve) => (releaseScan = resolve))
    let scanCount = 0
    const scanSpy = vi.spyOn(vaultStore, 'scanVault').mockImplementation(async (...args) => {
      const snapshot = await actualScan(...args)
      if (++scanCount === 2) {
        scanStarted()
        await blocked
      }
      return snapshot
    })

    const activePromise = openActiveVault({
      claims: CLAIMS,
      remote: 'syv-ai/notes',
      repo: openRepo(dir),
      onSnapshot: snaps.push,
      onSyncState: () => {},
      timings: {
        rescanDebounceMs: 20,
        commitQuietMs: 60_000,
        healIntervalMs: 60_000,
        pullIntervalMs: 60_000,
      },
    })
    await started
    await writeFile(join(dir, 'during-rescan.md'), '# During rescan\n', 'utf8')
    onChange!()
    const staleSnapshot = snaps.next()
    releaseScan()
    await staleSnapshot
    expect(paths(snaps.last)).not.toContain('during-rescan.md')
    const active = await activePromise
    open.push(active)
    watchSpy.mockRestore()
    scanSpy.mockRestore()

    await waitFor('the queued snapshot rescan', () =>
      paths(active.snapshot()).includes('during-rescan.md'),
    )
    expect(paths(active.snapshot())).toContain('during-rescan.md')
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

    expect(snaps.last.claimed.tasks!.items.map((t) => t.path)).toEqual(['task.ship-it.md'])
  })

  it('pushes a snapshot when a file is deleted', async () => {
    const { snaps, dir } = await vault({ rescanDebounceMs: 30 })

    await rm(join(dir, 'README.md'))
    await snaps.next()

    expect(paths(snaps.last)).toEqual([])
  })

  it('heals a change the watcher never reported', async () => {
    // Why the watcher carries no payload, made into a test. The macOS backend
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

    expect((await active.repo.status()).dirty).toBe(false)
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
      claims: CLAIMS,
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
    // As in a seeded vault, so the held-back list Holi writes stays local.
    await writeFile(join(dir, '.gitignore'), '*.local.*\n', 'utf8')
    await writeFile(join(dir, 'note.md'), 'a thought\n', 'utf8')
    await writeFile(join(dir, 'big.bin'), 'x'.repeat(2000), 'utf8')
    await sleep(QUIESCE)

    const held: HeldBackFile[][] = []
    const active = await openActiveVault({
      claims: CLAIMS,
      remote: 'syv-ai/notes',
      repo: openRepo(dir),
      onSnapshot: () => {},
      onSyncState: () => {},
      onHeldBack: (f) => held.push(f),
      // Loops off; if it commits, opening did. This pins the gate.
      timings: { commitQuietMs: 60_000, healIntervalMs: 60_000, pullIntervalMs: 60_000 },
    })
    open.push(active)

    // The note + settings landed; big.bin is held back, still on disk, and the
    // tree reads clean rather than perpetually dirty: one commit ahead, its
    // coalesced push not due yet.
    expect((await active.repo.status()).dirtyPaths).toEqual(['big.bin'])
    expect(active.syncState()).toEqual({ kind: 'unsynced', ahead: 1, behind: 0 })
    expect(active.heldBack()).toEqual([{ path: 'big.bin', bytes: 2000, limit: 1024 }])
    expect(held.at(-1)).toEqual([{ path: 'big.bin', bytes: 2000, limit: 1024 }])
    await expect(readFile(join(dir, 'big.bin'), 'utf8')).resolves.toHaveLength(2000)
    // Listed for the agent's prompt hook, and gone once nothing is held back.
    expect(JSON.parse(await readFile(join(dir, HELD_BACK_FILE), 'utf8'))).toEqual({
      paths: ['big.bin'],
    })
    await rm(join(dir, 'big.bin'))
    await active.commitNow()
    await expect(readFile(join(dir, HELD_BACK_FILE), 'utf8')).rejects.toThrow()
  })

  it('applies a changed size cap to the next commit, not the next open', async () => {
    // The settings pane edits the cap while the vault is open, and says it
    // applies to every commit. So does the pre-commit hook the agent's own
    // commits go through.
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    const active = await openActiveVault({
      claims: CLAIMS,
      remote: 'syv-ai/notes',
      repo: openRepo(dir),
      onSnapshot: () => {},
      onSyncState: () => {},
      timings: { commitQuietMs: 60_000, healIntervalMs: 60_000, pullIntervalMs: 60_000 },
    })
    open.push(active)

    await mkdir(join(dir, '.holi/settings'), { recursive: true })
    await writeFile(join(dir, SETTINGS_FILE), 'maxCommittedFileBytes: 1024\n', 'utf8')
    await writeFile(join(dir, 'big.bin'), 'x'.repeat(2000), 'utf8')
    await active.commitNow()

    expect(active.heldBack()).toEqual([{ path: 'big.bin', bytes: 2000, limit: 1024 }])
    await expect(readFile(join(dir, '.git/hooks/pre-commit'), 'utf8')).resolves.toContain(
      'limit=1024',
    )
  })

  it('does not spin an empty commit when only held-back files remain', async () => {
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    await mkdir(join(dir, '.holi/settings'), { recursive: true })
    await writeFile(join(dir, SETTINGS_FILE), '{"maxCommittedFileBytes": 1024}', 'utf8')
    await writeFile(join(dir, '.gitignore'), '*.local.*\n', 'utf8')
    await writeFile(join(dir, 'big.bin'), 'x'.repeat(2000), 'utf8')
    await sleep(QUIESCE)

    const active = await openActiveVault({
      claims: CLAIMS,
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
    // An agent turn touching ten files is one commit, not ten.
    const { dir } = await vault({ rescanDebounceMs: 30, commitQuietMs: 120 })
    const before = await count(dir)

    for (let i = 0; i < 10; i++) await writeFile(join(dir, `n${i}.md`), `${i}\n`, 'utf8')
    await waitFor('the coalesced commit', async () => (await count(dir)) > before)
    await sleep(SETTLE) // and then nothing further

    expect(await count(dir)).toBe(before + 1)
  })

  it('commits a file the watcher never reported', async () => {
    // The test that would fail under a watcher-driven loop.
    // git status is the truth about what needs committing; the watcher only
    // decides how soon we ask. An uncommitted file breaks the clean tree,
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

    expect(await subject(dir)).toBe('Update roadmap.md')
  })

  it('names a count in the message when several changed', async () => {
    // Committed at once rather than by the quiet timer: on a slow machine the
    // gap between two writes can outlast it, and the files land in two commits.
    const { active, dir } = await vault({ commitQuietMs: 60_000, healIntervalMs: 60_000 })
    for (const n of ['a', 'b', 'c']) await writeFile(join(dir, `${n}.md`), `${n}\n`, 'utf8')
    await active.commitNow()

    expect(await subject(dir)).toBe('Update 3 files')
  })

  it('commitNow() commits without waiting for the timer', async () => {
    // ⌘S is a real commit point, not a placebo.
    const { active, dir } = await vault({ commitQuietMs: 60_000, healIntervalMs: 60_000 })
    const before = await count(dir)

    await writeFile(join(dir, 'saved.md'), 'now\n', 'utf8')
    const sha = await active.commitNow()

    expect(sha).not.toBeNull()
    expect(await count(dir)).toBe(before + 1)
  })

  it('still pulls after a resume when a settle commit runs right behind its commit', async () => {
    const { active, dir } = await vault({ commitQuietMs: 60_000, healIntervalMs: 60_000 })
    const repo = active.repo
    const pull = repo.pull.bind(repo)
    let pulls = 0
    repo.pull = async (...args) => {
      pulls += 1
      return pull(...args)
    }
    active.pause('the assistant is working')
    await writeFile(join(dir, 'turn.md'), 'the work\n', 'utf8')

    active.resume()
    await active.commitNow()

    await vi.waitFor(() => expect(pulls).toBeGreaterThan(0))
  })

  it('commitNow() during a commit already running answers with that commit', async () => {
    // A turn's settle commit asks right behind the commit the resume starts:
    // that one holds the turn's work, and the turn needs to know which it is.
    const { active, dir } = await vault({ commitQuietMs: 60_000, healIntervalMs: 60_000 })
    const repo = active.repo
    const commit = repo.commitAll.bind(repo)
    let started!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => (started = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    repo.commitAll = async (...args) => {
      started()
      await gate
      return commit(...args)
    }
    await writeFile(join(dir, 'turn.md'), 'the work\n', 'utf8')
    const first = active.commitNow()
    await entered
    const second = active.commitNow()
    release()
    const sha = await first
    expect(sha).not.toBeNull()
    expect(await second).toBe(sha)

    // A write that comes after the running commit read the status (a buffer
    // ⌘S flushed) is committed too, rather than answered with that commit.
    const entered2 = new Promise<void>((resolve) => (started = resolve))
    const gate2 = new Promise<void>((resolve) => (release = resolve))
    repo.commitAll = async (...args) => {
      started()
      await gate2
      return commit(...args)
    }
    await writeFile(join(dir, 'turn.md'), 'more work\n', 'utf8')
    const third = active.commitNow()
    await entered2
    await writeFile(join(dir, 'saved.md'), 'flushed\n', 'utf8')
    const fourth = active.commitNow()
    release()
    const running = await third
    const after = await fourth
    expect(after).not.toBeNull()
    expect(after).not.toBe(running)
    expect((await repo.status()).dirty).toBe(false)
  })

  it('reports the paths a commit took, so open files can refresh their history', async () => {
    // Nothing on disk changes when a file is committed, so no snapshot says
    // so; a task opened before its first autosave commit showed no history.
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    const committed: (string[] | null)[] = []
    const active = await openActiveVault({
      claims: CLAIMS,
      remote: 'syv-ai/notes',
      repo: openRepo(dir),
      onSnapshot: () => {},
      onSyncState: () => {},
      onCommitted: (paths) => committed.push(paths),
      timings: { commitQuietMs: 60_000, healIntervalMs: 60_000, pullIntervalMs: 60_000 },
    })
    open.push(active)

    await writeFile(join(dir, 'task.buy-milk.md'), '# buy milk\n', 'utf8')
    await active.commitNow()
    expect(committed).toEqual([['task.buy-milk.md']])

    // A clean tree commits nothing and reports nothing.
    await active.commitNow()
    expect(committed).toHaveLength(1)
  })

  it('deliverNow joins a commit already in flight before verifying and pushing', async () => {
    const { active, dir, origin } = await vault({
      commitQuietMs: 60_000,
      pushQuietMs: 60_000,
      healIntervalMs: 60_000,
      pullIntervalMs: 60_000,
    })
    const repo = active.repo
    const commit = repo.commitAll.bind(repo)
    let started!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => (started = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    repo.commitAll = async (...args) => {
      started()
      await gate
      return commit(...args)
    }
    await writeFile(join(dir, 'settled.md'), 'current\n')
    const committing = active.commitNow()
    await entered
    let verified = false
    const delivery = active.deliverNow('settled.md', async () => {
      verified = true
      return (await plainGit(dir, ['show', 'HEAD:settled.md'])) === 'current'
    })
    await sleep(20)
    expect(verified).toBe(false)
    release()
    await committing
    expect(await delivery).toBe(true)
    expect(verified).toBe(true)
    expect(await plainGit(origin, ['show', 'main:settled.md'])).toBe('current')
  })

  it('keeps a hook-rejected CLI commit from auto-pushing until a verified retry', async () => {
    const { active, dir, origin } = await vault({
      commitQuietMs: 60_000,
      pushQuietMs: 80,
      healIntervalMs: 60_000,
      pullIntervalMs: 60_000,
    })
    await plainGit(dir, ['config', 'filter.strip.clean', "sed '/REJECTED/d'"])
    await writeFile(join(dir, '.git', 'info', 'attributes'), 'note.md filter=strip\n')
    const rejected = 'wanted\nREJECTED\n'
    await writeFile(join(dir, 'note.md'), rejected)
    const rejectedDelivery = await active.deliverNow(
      'note.md',
      async () => (await plainGit(dir, ['show', 'HEAD:note.md'])) === rejected.trimEnd(),
    )
    expect(rejectedDelivery).toBe(false)
    await sleep(250)
    expect(await plainGit(origin, ['rev-parse', 'refs/heads/main'])).not.toBe(
      await plainGit(dir, ['rev-parse', 'HEAD']),
    )
    expect(await plainGit(origin, ['cat-file', '-e', 'main:note.md']).catch(() => '')).toBe('')

    // The path reservation survives close/reopen; open-time auto-push must not
    // publish the outstanding rejected commit.
    await active.close()
    const reopened = await openActiveVault({
      claims: CLAIMS,
      remote: 'syv-ai/notes',
      repo: openRepo(dir),
      onSnapshot: () => {},
      onSyncState: () => {},
      timings: {
        commitQuietMs: 60_000,
        pushQuietMs: 60_000,
        healIntervalMs: 60_000,
        pullIntervalMs: 60_000,
      },
    })
    open.push(reopened)
    await sleep(100)
    expect(await plainGit(origin, ['cat-file', '-e', 'main:note.md']).catch(() => '')).toBe('')

    // Verifying another note must not release note.md's quarantine. Both
    // commits remain local until the rejected path itself is corrected.
    await writeFile(join(dir, 'other.md'), 'unrelated\n')
    expect(
      await reopened.deliverNow(
        'other.md',
        async () => (await plainGit(dir, ['show', 'HEAD:other.md'])) === 'unrelated',
      ),
    ).toBe(false)
    await sleep(250)
    expect(await plainGit(origin, ['cat-file', '-e', 'main:other.md']).catch(() => '')).toBe('')
    expect(await plainGit(origin, ['cat-file', '-e', 'main:note.md']).catch(() => '')).toBe('')

    const corrected = 'wanted\ncorrected\n'
    await writeFile(join(dir, 'note.md'), corrected)
    expect(
      await reopened.deliverNow(
        'note.md',
        async () => (await plainGit(dir, ['show', 'HEAD:note.md'])) === corrected.trimEnd(),
      ),
    ).toBe(true)
    await waitFor(
      'the corrected note to reach origin',
      async () =>
        (await plainGit(origin, ['show', 'main:note.md']).catch(() => '')) === corrected.trimEnd(),
    )
  })

  it('keeps a rejected follow-up commit quarantined after the first push', async () => {
    const { active, dir, origin } = await vault({
      commitQuietMs: 60_000,
      pushQuietMs: 60_000,
      healIntervalMs: 60_000,
      pullIntervalMs: 60_000,
    })
    const repo = active.repo
    const push = repo.push.bind(repo)
    let injected = false
    repo.push = async () => {
      const result = await push()
      if (!injected) {
        injected = true
        await writeFile(join(dir, 'delivery.md'), 'rejected follow-up\n')
      }
      return result
    }
    await writeFile(join(dir, 'delivery.md'), 'verified first commit\n')
    let verifications = 0
    expect(await active.deliverNow('delivery.md', async () => ++verifications === 1)).toBe(false)
    expect(verifications).toBe(2)
    await sleep(250)
    expect(await plainGit(origin, ['show', 'main:delivery.md'])).toBe('verified first commit')

    await active.close()
    const reopened = await openActiveVault({
      claims: CLAIMS,
      remote: 'syv-ai/notes',
      repo: openRepo(dir),
      onSnapshot: () => {},
      onSyncState: () => {},
      timings: {
        commitQuietMs: 60_000,
        pushQuietMs: 60_000,
        healIntervalMs: 60_000,
        pullIntervalMs: 60_000,
      },
    })
    open.push(reopened)
    await sleep(150)
    expect(await plainGit(origin, ['show', 'main:delivery.md'])).toBe('verified first commit')
  })

  it('deliverNow joins an in-flight push before finishing', async () => {
    const { active, dir, origin } = await vault({
      commitQuietMs: 60_000,
      pushQuietMs: 60_000,
      healIntervalMs: 60_000,
      pullIntervalMs: 60_000,
    })
    const repo = active.repo
    const push = repo.push.bind(repo)
    let started!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => (started = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    repo.push = async () => {
      started()
      await gate
      return push()
    }
    await writeFile(join(dir, 'pushed.md'), 'current\n')
    await active.commitNow()
    const pushing = active.pushNow()
    await entered
    let verified = false
    const delivery = active.deliverNow('pushed.md', async () => {
      verified = true
      return true
    })
    await sleep(20)
    expect(verified).toBe(false)
    release()
    await pushing
    expect(await delivery).toBe(true)
    expect(verified).toBe(true)
    expect(await plainGit(origin, ['show', 'main:pushed.md'])).toBe('current')
  })

  it('commitNow() returns null and commits nothing on a clean tree', async () => {
    const { active, dir } = await vault(quick)
    const before = await count(dir)
    expect(await active.commitNow()).toBeNull()
    expect(await count(dir)).toBe(before)
  })

  it('stops committing while paused, and resumes', async () => {
    // Autosave pauses during a reconcile, and while paused the vault
    // says so.
    const { active, dir } = await vault(quick)
    // Opening schedules a post-listening rescan and its initial commit check.
    // Let that startup work drain before taking the pause test's baseline.
    await sleep(SETTLE)
    const before = await count(dir)

    active.pause('reconciling')
    await writeFile(join(dir, 'during.md'), 'x\n', 'utf8')
    await sleep(SETTLE)
    expect(await count(dir)).toBe(before)
    expect(active.syncState()).toEqual({ kind: 'paused', reason: 'reconciling', manual: true })

    // Queue both edits while paused, so resume owns one deterministic flush.
    // Writing after resume would race retry()'s immediate maybeCommit(): two
    // commits would then be valid, not evidence of a duplicate commit.
    await writeFile(join(dir, 'after.md'), 'y\n', 'utf8')
    active.resume()
    await waitFor('the work to be committed after resuming', async () => {
      const tracked = await plainGit(dir, ['ls-tree', '-r', '--name-only', 'HEAD'])
      return tracked.includes('during.md') && tracked.includes('after.md')
    })
    await sleep(SETTLE)
    expect(await count(dir)).toBe(before + 1)
    const tracked = await plainGit(dir, ['ls-tree', '-r', '--name-only', 'HEAD'])
    expect(tracked).toContain('during.md')
    expect(tracked).toContain('after.md')
    expect((await active.repo.status()).dirty).toBe(false)
  })

  it('commits on a branch that is not the default one: sync follows the branch', async () => {
    // Sync follows the checked-out branch (docs/features/vaults-sync.md), so a
    // branch is an ordinary place to work, not a reason to pause.
    const { active, dir } = await vault(quick)
    await plainGit(dir, ['checkout', '-b', 'spike/idea'])
    const before = await count(dir)

    await writeFile(join(dir, 'on-a-branch.md'), 'x\n', 'utf8')
    await waitFor('the autosave on the branch', async () => (await count(dir)) === before + 1)
    expect(await plainGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('spike/idea')
    expect(active.syncState().kind).not.toBe('paused')
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
      claims: CLAIMS,
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
    // The exception to the branch rule. `github.createRepo` makes an empty repo, so the
    // clone has no commits at all, and its first autosave must land rather
    // than be mistaken for a broken checkout.
    const base = await tmp('holi-unborn-')
    const dir = join(base, 'fresh')
    await plainGit(base, ['init', '-b', 'main', dir])
    await plainGit(dir, ['config', 'user.name', 'Holi Test'])
    await plainGit(dir, ['config', 'user.email', 'test@holi.invalid'])
    await sleep(QUIESCE)

    const active = await openActiveVault({
      claims: CLAIMS,
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
  async function withTeammate(
    timings?: Parameters<typeof openActiveVault>[0]['timings'],
    onCommitted?: (paths: string[] | null) => void,
  ) {
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    const teammate = await makeClone(origin, 'teammate')
    await sleep(QUIESCE)
    const snaps = snapshots()
    const active = await openActiveVault({
      claims: CLAIMS,
      remote: 'syv-ai/notes',
      repo: openRepo(dir),
      onSnapshot: snaps.push,
      onSyncState: () => {},
      onCommitted,
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
   * It is a real property of the design, not a test artifact — `features/vaults-sync.md`
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

  async function topicBehind(upstream: 'none' | 'main') {
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    const teammate = await makeClone(origin, 'teammate')
    await plainGit(dir, ['switch', '-c', 'topic'])
    await plainGit(dir, ['push', '-u', 'origin', 'topic'])
    await plainGit(teammate, ['fetch', 'origin'])
    await plainGit(teammate, ['switch', '--track', 'origin/topic'])
    await writeFile(join(teammate, 'remote.md'), 'remote change\n', 'utf8')
    await plainGit(teammate, ['add', '-A'])
    await plainGit(teammate, ['commit', '-m', 'remote topic change'])
    await plainGit(teammate, ['push', 'origin', 'topic'])
    await plainGit(dir, ['fetch', 'origin'])
    if (upstream === 'none') {
      await plainGit(dir, ['branch', '--unset-upstream'])
    } else {
      await plainGit(dir, ['branch', '--set-upstream-to=origin/main'])
    }
    await sleep(QUIESCE)
    const active = await openActiveVault({
      claims: CLAIMS,
      remote: 'syv-ai/notes',
      repo: openRepo(dir),
      onSnapshot: () => {},
      onSyncState: () => {},
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000 },
    })
    open.push(active)
    return active
  }

  it('counts commits behind origin/<branch> without a configured upstream', async () => {
    const active = await topicBehind('none')

    expect(active.syncState()).toEqual({ kind: 'unsynced', ahead: 0, behind: 1 })
  })

  it('counts commits behind origin/<branch> when upstream points elsewhere', async () => {
    const active = await topicBehind('main')

    expect(active.syncState()).toEqual({ kind: 'unsynced', ahead: 0, behind: 1 })
  })

  it('pulls on the interval, and the tree updates itself', async () => {
    // A teammate's work arrives without anyone remembering
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

  it('reports a merged pull as history moving for any file', async () => {
    const committed: (string[] | null)[] = []
    const { teammate } = await withTeammate({ pullIntervalMs: 80 }, (paths) =>
      committed.push(paths),
    )
    await theyPublish(teammate, 'theirs.md', 'their note\n')
    await waitFor('the pull to report', () => committed.includes(null))
  })

  it('reports up-to-date when nothing has changed', async () => {
    const { active } = await withTeammate({ pullIntervalMs: 80 })
    await waitFor('a settled state', () => active.syncState().kind === 'up-to-date')
  })

  it('pushes a landed commit to the remote on the coalesce timer', async () => {
    // Push is automatic: a committed change reaches the remote without anyone
    // clicking anything (`features/vaults-sync.md`).
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

  it('an explicit push requested while another push is in flight follows it', async () => {
    // The open-drain push can still be running when ⌘S asks for a push. That
    // request must not be dropped: it resolves only once a second push has
    // carried the commit that landed after the first one started.
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    await sleep(QUIESCE)
    const real = openRepo(dir)
    let pushes = 0
    let running = 0
    let overlapped = false
    let started!: () => void
    const firstStarted = new Promise<void>((r) => (started = r))
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const active = await openActiveVault({
      claims: CLAIMS,
      remote: 'syv-ai/notes',
      repo: {
        ...real,
        push: async () => {
          const n = ++pushes
          running++
          if (running > 1) overlapped = true
          try {
            const result = await real.push()
            if (n === 1) {
              started()
              await gate
            }
            return result
          } finally {
            running--
          }
        },
      },
      onSnapshot: () => {},
      onSyncState: () => {},
      // Neither timer may do the work: the explicit request has to.
      timings: {
        commitQuietMs: 60_000,
        pushQuietMs: 60_000,
        pullIntervalMs: 60_000,
        healIntervalMs: 60_000,
      },
    })
    open.push(active)
    await firstStarted

    await writeFile(join(dir, 'late.md'), 'late\n', 'utf8')
    await plainGit(dir, ['add', 'late.md'])
    await plainGit(dir, ['commit', '-m', 'late'])

    const explicit = active.pushNow()
    const second = active.pushNow()
    release()
    await Promise.all([explicit, second])

    expect(await plainGit(origin, ['log', 'main', '--format=%s'])).toContain('late')
    expect(pushes).toBe(2)
    expect(overlapped).toBe(false)
  })

  it('shows offline with the waiting count when a push cannot reach the remote', async () => {
    // The one time unpushed commits are worth naming: the network is gone and
    // they are piling up. The indicator must not say "synced" then, and a bare
    // "offline" hides how much is waiting.
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    await sleep(QUIESCE)
    const real = openRepo(dir)
    const active = await openActiveVault({
      claims: CLAIMS,
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

  it('says ahead and behind, not up to date, while a pull keeps declining', async () => {
    // A vault found stuck this way: the remote moved, every push is rejected, and the
    // recovery pull never gets to merge. Nothing failed outright, and the vault
    // is not up to date; `holi sync status` says the state's label.
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    const teammate = await makeClone(origin, 'teammate')
    await writeFile(join(teammate, 'theirs.md'), 'theirs\n', 'utf8')
    await plainGit(teammate, ['add', '-A'])
    await plainGit(teammate, ['commit', '-m', 'theirs'])
    await plainGit(teammate, ['push', 'origin', 'main'])
    await writeFile(join(dir, 'mine.md'), 'mine\n', 'utf8')
    await plainGit(dir, ['add', '-A'])
    await plainGit(dir, ['commit', '-m', 'mine'])
    await plainGit(dir, ['fetch', 'origin'])
    await sleep(QUIESCE)
    const real = openRepo(dir)
    const active = await openActiveVault({
      claims: CLAIMS,
      remote: 'syv-ai/notes',
      // git refusing up front, as when someone types mid-pull: transient, so
      // no conflict latches and nothing reads as failed.
      repo: { ...real, pull: async () => ({ kind: 'conflict' as const, paths: [] }) },
      onSnapshot: () => {},
      onSyncState: () => {},
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000 },
    })
    open.push(active)

    await active.pushNow()
    await waitFor('the unsynced state', () => active.syncState().kind === 'unsynced')
    expect(active.syncState()).toEqual({ kind: 'unsynced', ahead: 1, behind: 1 })
    expect(syncLabel(active.syncState()).text).toBe('1 ahead, 1 behind')
  })

  it('alerts once when sync keeps failing, and again only after it got through', async () => {
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    await sleep(QUIESCE)
    const real = openRepo(dir)
    let allowed = false
    const alerts: string[] = []
    const lines: string[] = []
    const active = await openActiveVault({
      claims: CLAIMS,
      remote: 'syv-ai/notes',
      repo: {
        ...real,
        push: async () =>
          allowed
            ? { kind: 'nothing-to-push' as const }
            : { kind: 'rejected' as const, reason: 'permission' as const },
      },
      onSnapshot: () => {},
      onSyncState: () => {},
      onSyncFailing: (text) => alerts.push(text),
      activity: (entry) => lines.push(entry.message),
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000 },
    })
    open.push(active)

    // The open-time push may already have failed once, so count up to the alert.
    for (let i = 0; i < SYNC_ALERT_FAILURES && alerts.length === 0; i++) await active.pushNow()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain(`failed ${SYNC_ALERT_FAILURES} times`)
    expect(alerts[0]).toContain('no write access')
    // Still failing is the same run: no second alert.
    await active.pushNow()
    expect(alerts).toHaveLength(1)

    allowed = true
    await active.pushNow()
    expect(lines).toContain('Sync is getting through again')
    allowed = false
    for (let i = 1; i < SYNC_ALERT_FAILURES; i++) await active.pushNow()
    expect(alerts).toHaveLength(1)
    await active.pushNow()
    expect(alerts).toHaveLength(2)
  })

  /** A vault whose pushes fail on the network while `failing()` says so. */
  async function withFlakyPush(
    failing: () => boolean,
    failingAlertMs?: number,
    onPullCompleted?: () => void,
  ) {
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    await sleep(QUIESCE)
    const real = openRepo(dir)
    const alerts: string[] = []
    const active = await openActiveVault({
      claims: CLAIMS,
      remote: 'syv-ai/notes',
      repo: {
        ...real,
        pull: async () => {
          const result = await real.pull()
          onPullCompleted?.()
          return result
        },
        push: async () => {
          if (!failing()) return { kind: 'nothing-to-push' as const }
          throw new GitError('could not resolve host: github.com', 128, 'could not resolve host')
        },
      },
      onSnapshot: () => {},
      onSyncState: () => {},
      onSyncFailing: (text) => alerts.push(text),
      timings: {
        pullIntervalMs: 60_000,
        healIntervalMs: 60_000,
        ...(failingAlertMs === undefined ? {} : { failingAlertMs }),
      },
    })
    open.push(active)
    return { active, alerts }
  }

  it('times an outage rather than counting each push it fails', async () => {
    // Offline, every autosave burst fails a push: a short outage while editing
    // is not five failures.
    const { active, alerts } = await withFlakyPush(() => true)
    for (let i = 0; i <= SYNC_ALERT_FAILURES; i++) await active.pushNow()
    expect(alerts).toEqual([])
  })

  it('does not alert, when the time is up, about a blip a later pull got past', async ({
    onTestFinished,
  }) => {
    let failing = false
    let pullCompleted = false
    const failingAlertMs = 800
    let alertTimeout: (() => void) | undefined
    const realSetTimeout = globalThis.setTimeout.bind(globalThis)
    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((handler, timeout, ...args) => {
        if (timeout === failingAlertMs && typeof handler === 'function') {
          alertTimeout = handler
          return realSetTimeout(handler, 60_000, ...args)
        }
        return realSetTimeout(handler, timeout, ...args)
      })
    onTestFinished(() => {
      setTimeoutSpy.mockRestore()
    })

    const { active, alerts } = await withFlakyPush(
      () => failing,
      failingAlertMs,
      () => {
        pullCompleted = true
      },
    )
    await active.pushNow()
    failing = true
    await active.pushNow()
    failing = false
    // A pull reaches the remote, and no push follows it. Hold only the alert
    // timer so fixture IO cannot race the retry's real pull.
    pullCompleted = false
    await active.retry()
    expect(pullCompleted).toBe(true)
    expect(alertTimeout).toBeDefined()
    expect(alerts).toEqual([])

    // Even if the delayed callback runs after recovery, it must not report the
    // cleared failure.
    alertTimeout!()
    expect(alerts).toEqual([])
  })

  it('keeps a permission rejection failing after a successful pull', async ({ onTestFinished }) => {
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    await sleep(QUIESCE)
    const real = openRepo(dir)
    // Keep real filesystem, git and watcher timing, but hold only the failure
    // alert until the real push and pull have completed. This proves the pull
    // did not clear the permission failure without racing its alert timer
    // against fixture IO. Use a distinct delay to leave the commit timer alone.
    const failingAlertMs = 12_345
    let alertTimeout: (() => void) | undefined
    const realSetTimeout = globalThis.setTimeout.bind(globalThis)
    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((handler, timeout, ...args) => {
        if (timeout === failingAlertMs && typeof handler === 'function') {
          alertTimeout = handler
          return realSetTimeout(handler, 60_000, ...args)
        }
        return realSetTimeout(handler, timeout, ...args)
      })
    onTestFinished(() => {
      setTimeoutSpy.mockRestore()
    })
    const alerts: { text: string; afterPull: boolean }[] = []
    let pulled = false
    const active = await openActiveVault({
      claims: CLAIMS,
      remote: 'syv-ai/notes',
      repo: {
        ...real,
        pull: async () => {
          const result = await real.pull()
          pulled = true
          return result
        },
        push: async () => ({ kind: 'rejected' as const, reason: 'permission' as const }),
      },
      onSnapshot: () => {},
      onSyncState: () => {},
      onSyncFailing: (text) => alerts.push({ text, afterPull: pulled }),
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000, failingAlertMs },
    })
    open.push(active)

    await active.pushNow()
    await active.retry()
    expect(pulled).toBe(true)
    expect(alertTimeout).toBeDefined()
    alertTimeout!()
    expect(alerts).toHaveLength(1)
    expect(alerts[0].afterPull).toBe(true)
    expect(alerts[0].text).toContain('Sync has failed')
  })

  it('alerts on a conflict left waiting, naming its files, once the time is up', async () => {
    // A conflict stops the pulls and pushes that would count as failures, so
    // the time trigger is what says it.
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    await sleep(QUIESCE)
    const real = openRepo(dir)
    const alerts: string[] = []
    const active = await openActiveVault({
      claims: CLAIMS,
      remote: 'syv-ai/notes',
      repo: { ...real, pull: async () => ({ kind: 'conflict' as const, paths: ['a.md'] }) },
      onSnapshot: () => {},
      onSyncState: () => {},
      onSyncFailing: (text) => alerts.push(text),
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000, failingAlertMs: 100 },
    })
    open.push(active)

    await active.retry()
    await waitFor('the conflict', () => active.syncState().kind === 'conflict')
    await waitFor('the alert', () => alerts.length > 0)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('1 file conflict: a.md')
  })

  it('reports a permission rejection as no-access, not offline', async () => {
    // "You lost write access" and "you are offline" send someone to two
    // entirely different places, so they must never be the same word.
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    await sleep(QUIESCE)
    const real = openRepo(dir)
    const active = await openActiveVault({
      claims: CLAIMS,
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
    // The most important assertion here. A conflicted tree contains
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
    // pull() aborted, so the tree is clean with a sticky banner.
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
    // While the agent works, the vault
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
    // vault Holi must not touch, not a reconcile in progress — and the
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
    // A reconcile "resumes normal operation once the tree is clean". Nobody tells
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
    // worth nothing if autosave stays off. The reconcile pauses it;
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
    // The pre-reconcile state is a clean tree with a conflict still
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
    // lifts it, clearing the sticky conflict pause on the way out (the conflict
    // pause's escape). A reconcile runs *through* the agent, so its first turn ending
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
    // The banner is non-blocking — ignore it and you keep working on an
    // unbroken vault. Only a reconcile pauses autosave.
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

  it('keeps the conflict banner when someone checks out another branch by hand', async () => {
    // The banner is sticky: a teammate's change is still waiting on main, and
    // a checkout in the terminal does not deal with it. The picker refuses to
    // switch here; this is the terminal's way round it.
    // BOTH background loops are off and every step is driven explicitly.
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
    expect(active.syncState().kind).toBe('conflict')
  })

  it('retry() clears the conflict and lets auto-pull start again', async () => {
    // A reconcile "resumes normal operation once the tree is clean".
    // The conflict pause is sticky by design, so if
    // nothing ever clears it the vault is stranded — the banner stays up
    // forever and no pull is ever attempted again, even after the conflict has
    // actually been resolved. retry() ("Try again", and the end of an agent
    // turn through resume()) is the way back, with or without an agent.
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
      // onFocus() is not enough: if one lands while retry()'s own pull is
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

    // Until retry(), the vault is stranded: it will never look again.
    await sleep(300)
    expect(active.syncState().kind).toBe('conflict')

    await active.retry()
    await waitFor('sync to recover', () => active.syncState().kind !== 'conflict')

    // And it really is syncing again, not just displaying differently. The
    // interval is off in this test, so the next pull is driven by focus —
    // which is itself a pull trigger, and would equally have been refused
    // while the conflict pause was still latched.
    await theyPublish(teammate, 'after-recovery.md', 'arrived\n')
    await waitFor('a pull after recovering', async () => {
      active.onFocus()
      return (await readFile(join(dir, 'after-recovery.md'), 'utf8').catch(() => null)) !== null
    })
  })

  it('recovers from a non-fast-forward push by pulling then retrying', async () => {
    // The remote moved under us. Rather than surface a rejection, pushNow pulls
    // and retries — both sides survive (`features/vaults-sync.md`). A push
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
    // git held for 200 ms. Push has the same rule: a permission
    // failure must never be confused with a network one, and the inverse is
    // just as bad. Telling someone their vault is offline sends them to look at
    // their wifi for a problem that is already over.
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    await sleep(QUIESCE)
    const real = openRepo(dir)
    let pulls = 0
    const active = await openActiveVault({
      claims: CLAIMS,
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
    // and pull "on window focus" quietly stopped holding for the next
    // alt-tab, which is the one the user is waiting on.
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    await sleep(QUIESCE)
    const real = openRepo(dir)
    let pulls = 0
    let release = () => {}
    const firstPullHangs = new Promise<void>((r) => (release = r))
    const active = await openActiveVault({
      claims: CLAIMS,
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
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000, focusThrottleMs: 60_000 },
    })
    open.push(active)

    // The throttle reads `Date.now()`, so the clock is moved rather than waited
    // on. With a real 300 ms throttle this test raced itself both ways: the
    // pull after the last focus spawns `git status` twice before the stub
    // counts it, which on a loaded machine outran a wait shorter than the
    // throttle, and a release that took longer than the throttle let the bug
    // through. Only Date is faked; the vault's own timers stay real.
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
    try {
      active.onFocus()
      await waitFor('the first pull to start', () => pulls === 1)
      // Past the throttle, so this focus is entitled to a pull — and cannot
      // have one, because the first is still fetching.
      vi.setSystemTime(Date.now() + 61_000)
      active.onFocus()

      release()
      await waitFor('the first pull to finish', () => active.syncState().kind !== 'pulling')
      // Well inside a window the focus above would have stamped: with the bug
      // it has been spent, and no amount of waiting produces a second pull.
      active.onFocus()

      await waitFor('a pull on the focus after the fetch', () => pulls === 2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not strand the vault when a push-recovery pull conflicts but names no paths', async () => {
    // A non-fast-forward push triggers a recovery pull; when that merge is
    // refused before it starts — a tree that went dirty, an index.lock lost to
    // the user's own git — it comes back naming nothing. `maybePull` already
    // refuses to latch the sticky conflict pause on that, and pushNow inherits it by
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
      claims: CLAIMS,
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

  it('pulls past a held-back file, so a rejected push still recovers', async () => {
    // A held-back file is never committed, so a pull that waited for a clean
    // tree never ran: every push failed non-fast-forward, under up to date.
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    const teammate = await makeClone(origin, 'teammate')
    await mkdir(join(dir, '.holi/settings'), { recursive: true })
    await writeFile(join(dir, SETTINGS_FILE), 'maxCommittedFileBytes: 1024\n', 'utf8')
    await writeFile(join(dir, 'big.bin'), 'x'.repeat(2000), 'utf8')
    await theyPublish(teammate, 'theirs.md', 'theirs\n')
    await sleep(QUIESCE)
    const active = await openActiveVault({
      claims: CLAIMS,
      remote: 'syv-ai/notes',
      repo: openRepo(dir),
      onSnapshot: () => {},
      onSyncState: () => {},
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000 },
    })
    open.push(active)

    await active.commitNow()
    await active.pushNow()
    const status = await active.repo.status()
    expect(status.dirtyPaths).toEqual(['big.bin'])
    expect([status.ahead, status.behind]).toEqual([0, 0])
  })

  it('names a held-back file a teammate changed, rather than retrying in silence', async () => {
    // git refuses the merge before it starts, naming no paths, and the held
    // file will never be committed, so this refusal is not transient.
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    const teammate = await makeClone(origin, 'teammate')
    await mkdir(join(dir, '.holi/settings'), { recursive: true })
    await writeFile(join(dir, SETTINGS_FILE), 'maxCommittedFileBytes: 1024\n', 'utf8')
    await writeFile(join(dir, 'big.bin'), 'x'.repeat(2000), 'utf8')
    await theyPublish(teammate, 'big.bin', 'theirs\n')
    await sleep(QUIESCE)
    const active = await openActiveVault({
      claims: CLAIMS,
      remote: 'syv-ai/notes',
      repo: openRepo(dir),
      onSnapshot: () => {},
      onSyncState: () => {},
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000 },
    })
    open.push(active)

    await active.commitNow()
    await active.pushNow()
    const state = active.syncState()
    expect(state.kind).toBe('paused')
    expect(state.kind === 'paused' && state.reason).toContain('big.bin')
    expect(active.syncInfo().lastError).toContain('big.bin')
  })

  it('reports a real conflict during a push recovery and pushes nothing', async () => {
    // The user's work stays local and intact, the remote is
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
    // Focus is the trigger that makes the interval nearly irrelevant.
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

  it('pulls the checked-out branch, not the default one', async () => {
    // The branch is switched BEFORE the vault opens. A teammate's push to main
    // does not reach a vault on spike/idea; their push to spike/idea does.
    const origin = await makeRemote()
    const teammate = await makeClone(origin, 'teammate')
    await plainGit(teammate, ['checkout', '-b', 'spike/idea'])
    await plainGit(teammate, ['push', '-u', 'origin', 'spike/idea'])
    const dir = await makeClone(origin)
    await plainGit(dir, ['switch', '--track', 'origin/spike/idea'])
    await sleep(QUIESCE)

    const active = await openActiveVault({
      claims: CLAIMS,
      remote: 'syv-ai/notes',
      repo: openRepo(dir),
      onSnapshot: () => {},
      onSyncState: () => {},
      timings: { pullIntervalMs: 80, healIntervalMs: 60_000 },
    })
    open.push(active)
    await plainGit(teammate, ['checkout', 'main'])
    await theyPublish(teammate, 'on-main.md', 'main\n')
    await plainGit(teammate, ['checkout', 'spike/idea'])
    await writeFile(join(teammate, 'on-spike.md'), 'spike\n', 'utf8')
    await plainGit(teammate, ['add', '-A'])
    await plainGit(teammate, ['commit', '-m', 'spike'])
    await plainGit(teammate, ['push', 'origin', 'spike/idea'])

    await waitFor(
      'the branch’s note to arrive',
      async () => (await readFile(join(dir, 'on-spike.md'), 'utf8').catch(() => null)) !== null,
    )
    expect(await readFile(join(dir, 'on-main.md'), 'utf8').catch(() => null)).toBeNull()
  })

  it('detaches the bridge and closes a watcher when startup callback throws, then retries', async () => {
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    let attached = 0
    let detached = 0
    let watcherClosed = 0
    const bridgeEnv = {
      attach: async () => {
        attached++
      },
      detach: async () => {
        detached++
      },
    }
    const actualWatch = vaultWatcher.watchVault
    const watchSpy = vi.spyOn(vaultWatcher, 'watchVault').mockImplementation(async (options) => {
      const watcher = await actualWatch(options)
      return {
        close: async () => {
          watcherClosed++
          await watcher.close()
        },
      }
    })
    try {
      await expect(
        openActiveVault({
          claims: CLAIMS,
          remote: 'syv-ai/retry',
          repo: openRepo(dir),
          onSnapshot: () => {},
          onSyncState: () => {
            throw new Error('startup callback')
          },
          bridgeEnv,
          timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000 },
        }),
      ).rejects.toThrow('startup callback')
      expect(attached).toBe(1)
      expect(detached).toBe(1)
      expect(watcherClosed).toBe(1)

      const active = await openActiveVault({
        claims: CLAIMS,
        remote: 'syv-ai/retry',
        repo: openRepo(dir),
        onSnapshot: () => {},
        onSyncState: () => {},
        bridgeEnv,
        timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000 },
      })
      open.push(active)
      expect(attached).toBe(2)
    } finally {
      watchSpy.mockRestore()
    }
  })

  it('detaches an attached bridge when watcher startup fails', async () => {
    const origin = await makeRemote()
    const dir = await makeClone(origin)
    let detached = 0
    const watchSpy = vi
      .spyOn(vaultWatcher, 'watchVault')
      .mockRejectedValue(new Error('watch failed'))
    try {
      await expect(
        openActiveVault({
          claims: CLAIMS,
          remote: 'syv-ai/watch-failure',
          repo: openRepo(dir),
          onSnapshot: () => {},
          onSyncState: () => {},
          bridgeEnv: {
            attach: async () => {},
            detach: async () => {
              detached++
            },
          },
        }),
      ).rejects.toThrow('watch failed')
      expect(detached).toBe(1)
    } finally {
      watchSpy.mockRestore()
    }
  })

  it('does not pause when the branch changes under an open vault', async () => {
    // A checkout in the terminal is followed, not refused: the state is
    // derived fresh from `git status` and the branch is not part of it.
    const { active, dir } = await withTeammate({ pullIntervalMs: 60_000, healIntervalMs: 80 })

    await userGit(dir, ['checkout', '-b', 'spike/idea'])
    await sleep(SETTLE)
    expect(active.syncState().kind).not.toBe('paused')
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

  it('drains a held-back override before switching vaults', async () => {
    const { registry, a } = await twoVaults()
    const heldBackUpdates: string[][] = []
    const host = createVaultHost({
      registry,
      claims: async () => CLAIMS(),
      onSnapshot: () => {},
      onSyncState: () => {},
      onHeldBack: (_remote, files) => heldBackUpdates.push(files.map((file) => file.path)),
      timings: {
        rescanDebounceMs: 60_000,
        commitQuietMs: 60_000,
        healIntervalMs: 60_000,
        pullIntervalMs: 60_000,
        pushBudgetMs: 100,
      },
    })
    hosts.push(host)
    const active = await host.open('syv-ai/a')
    await active.pushNow()
    await writeFile(join(a, 'large.bin'), Buffer.alloc(10 * 1024 * 1024 + 1))
    await active.commitNow()
    await waitFor('the file to be held back', () =>
      active.heldBack().some((file) => file.path === 'large.bin'),
    )

    const updatesBeforeOverride = heldBackUpdates.length
    let release!: () => void
    let entered!: () => void
    const insideCommit = new Promise<void>((resolve) => (entered = resolve))
    const blocked = new Promise<void>((resolve) => (release = resolve))
    const commit = vi.spyOn(active.repo, 'commitFileNoVerify').mockImplementation(async (path) => {
      entered()
      await blocked
      return openRepo(a).commitFileNoVerify(path)
    })
    const override = active.commitHeldBack('large.bin')
    await insideCommit

    let switched = false
    const switching = host.open('syv-ai/b').then(() => {
      switched = true
    })
    await sleep(500)
    expect(switched).toBe(false)

    release()
    await override
    await switching
    commit.mockRestore()
    expect(host.active()?.remote).toBe('syv-ai/b')
    expect(heldBackUpdates.at(-1)).toEqual([])
    expect(
      heldBackUpdates
        .slice(updatesBeforeOverride)
        .flat()
        .some((path) => path === 'large.bin'),
    ).toBe(false)
  })

  const hosts: VaultHost[] = []
  afterEach(async () => {
    for (const h of hosts.splice(0)) await h.closeAll().catch(() => {})
  })

  function host(registry: VaultRegistry, timings: Partial<SyncTimings> = {}) {
    const snaps = snapshots()
    const h = createVaultHost({
      claims: CLAIMS,
      registry,
      onSnapshot: (_remote, snapshot) => snaps.push(snapshot),
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
   * one before it. The indicator must never claim a state that is
   * not true, and that cuts both ways.
   */
  it('announces the opening sync state, even when nothing changed', async () => {
    const { registry } = await twoVaults()
    const seen: string[] = []
    const h = createVaultHost({
      claims: CLAIMS,
      registry,
      onSnapshot: () => {},
      onSyncState: (_remote, s) => seen.push(s.kind),
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
      claims: CLAIMS,
      registry,
      onSnapshot: () => {},
      onSyncState: () => {},
      onHeldBack: (_remote, f) => held.push(f),
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000 },
    })
    hosts.push(h)

    await h.open('syv-ai/a')
    expect(held.at(-1)).toEqual([{ path: 'big.bin', bytes: 2000, limit: 1024 }])
  })

  it('waits for startup prerequisites before opening a vault', async () => {
    const { registry } = await twoVaults()
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const order: string[] = []
    const h = createVaultHost({
      claims: CLAIMS,
      registry,
      beforeOpen: async () => {
        order.push('prepare')
        await ready
      },
      onSnapshot: () => order.push('snapshot'),
      onSyncState: () => {},
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000 },
    })
    hosts.push(h)

    let opened = false
    const opening = h.open('syv-ai/a').then((vault) => {
      opened = true
      return vault
    })
    await sleep(0)
    expect(opened).toBe(false)
    expect(h.active()).toBeNull()

    release()
    const vault = await opening
    expect(h.active()).toBe(vault)
    expect(order.indexOf('prepare')).toBeLessThan(order.indexOf('snapshot'))
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
    // Exactly one watcher and one set of timers
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
    // The agent's sessions. A session teardown resumes the vault's sync
    // loop and may take a settle commit, so it has to run while the vault it
    // ran in is still the active one — not after the switch has moved on.
    const { registry } = await twoVaults()
    const leftFrom: Array<string | null> = []
    const h = createVaultHost({
      claims: CLAIMS,
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
      claims: CLAIMS,
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
    // Work is flushed and committed on a vault switch. A tree left dirty
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

  it('replays the selected runtime after a non-selecting start and isolates background callbacks', async () => {
    const { registry } = await twoVaults()
    const seen: Array<{ remote: string; snapshot: VaultSnapshot }> = []
    const states: string[] = []
    const h = createVaultHost({
      registry,
      claims: CLAIMS,
      onSnapshot: (remote, snapshot) => seen.push({ remote, snapshot }),
      onSyncState: (remote, state) => states.push(`${remote}:${state.kind}`),
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000 },
    })
    hosts.push(h)
    const a = await h.getOrOpen('syv-ai/a')
    const count = seen.length
    await h.open('syv-ai/b')
    expect(seen.at(-1)?.remote).toBe('syv-ai/b')
    const afterSelection = seen.length
    await a.refresh()
    expect(seen.length).toBe(afterSelection + 1)
    expect(seen.at(-1)?.remote).toBe('syv-ai/a')
    expect(states).toContain('syv-ai/b:up-to-date')
  })

  it('keeps the selected runtime when preparation for a switch fails', async () => {
    const { registry } = await twoVaults()
    let fail = false
    const h = createVaultHost({
      registry,
      claims: CLAIMS,
      beforeOpen: async () => {
        if (fail) throw new Error('preparation failed')
      },
      onSnapshot: () => {},
      onSyncState: () => {},
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000 },
    })
    hosts.push(h)
    const selected = await h.open('syv-ai/a')
    fail = true
    await expect(h.open('syv-ai/b')).rejects.toThrow('preparation failed')
    expect(h.active()).toBe(selected)
    expect(h.get('syv-ai/a')).toBe(selected)
  })

  it('opens despite a failed best-effort bridge attach and cleans partial work', async () => {
    const { registry } = await twoVaults()
    let detached = 0
    const h = createVaultHost({
      registry,
      claims: CLAIMS,
      bridgeEnv: {
        attach: async () => {
          throw new Error('partial attach')
        },
        detach: async () => {
          detached++
        },
      },
      onSnapshot: () => {},
      onSyncState: () => {},
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000 },
    })
    hosts.push(h)
    await expect(h.open('syv-ai/a')).resolves.toMatchObject({ remote: 'syv-ai/a' })
    expect(detached).toBeGreaterThan(0)
  })

  it('opens runtimes independently and closes only the requested remote', async () => {
    const { registry, a } = await twoVaults()
    const { h, snaps } = host(registry, { rescanDebounceMs: 30 })
    const first = await h.getOrOpen('syv-ai/a')
    const second = await h.getOrOpen('syv-ai/b')
    expect(h.active()).toBeNull()
    expect(h.get('syv-ai/a')).toBe(first)
    expect(h.get('syv-ai/b')).toBe(second)
    await h.open('syv-ai/b')
    await h.close('syv-ai/a')
    expect(h.active()).toBe(second)
    const before = snaps.count
    await writeFile(join(a, 'orphan.md'), 'closed runtime\\n', 'utf8')
    await sleep(SETTLE)
    expect(snaps.count).toBe(before)
    expect(h.get('syv-ai/a')).toBeNull()
    expect(h.get('syv-ai/b')).toBe(second)
  })

  it('coalesces concurrent starts for the same remote', async () => {
    const { registry } = await twoVaults()
    const { h } = host(registry)
    const [first, second] = await Promise.all([h.getOrOpen('syv-ai/a'), h.getOrOpen('syv-ai/a')])
    expect(first).toBe(second)
    expect(h.get('syv-ai/a')).toBe(first)
  })

  it('does not let a slow remote start block a different remote', async () => {
    const { registry, a, b } = await twoVaults()
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const h = createVaultHost({
      registry,
      claims: async (root) => {
        if (root === a) {
          entered()
          await gate
        }
        return CLAIMS()
      },
      onSnapshot: () => {},
      onSyncState: () => {},
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000 },
    })
    hosts.push(h)
    try {
      const slowA = h.getOrOpen('syv-ai/a')
      await started
      const fastB = await h.getOrOpen('syv-ai/b')
      expect(fastB.remote).toBe('syv-ai/b')
      release()
      expect((await slowA).remote).toBe('syv-ai/a')
    } finally {
      release()
    }
  })

  it('closeAll closes starts admitted before it and rejects starts during drain', async () => {
    const { registry, a } = await twoVaults()
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const h = createVaultHost({
      registry,
      claims: async (root) => {
        if (root === a) {
          entered()
          await gate
        }
        return CLAIMS()
      },
      onSnapshot: () => {},
      onSyncState: () => {},
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000 },
    })
    hosts.push(h)
    try {
      const pending = h.getOrOpen('syv-ai/a')
      await started
      const draining = h.closeAll()
      await expect(h.getOrOpen('syv-ai/b')).rejects.toThrow(/closing/)
      release()
      await pending
      await draining
      expect(h.get('syv-ai/a')).toBeNull()
      await expect(h.getOrOpen('syv-ai/b')).resolves.toMatchObject({ remote: 'syv-ai/b' })
    } finally {
      release()
    }
  })

  it('orders targeted close and reopen behind a visible open awaiting preparation', async () => {
    const { registry } = await twoVaults()
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let preparing = true
    const h = createVaultHost({
      registry,
      beforeOpen: async () => {
        if (preparing) {
          preparing = false
          entered()
          await gate
        }
      },
      claims: CLAIMS,
      onSnapshot: () => {},
      onSyncState: () => {},
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000 },
    })
    hosts.push(h)
    try {
      const visibleOpen = h.open('syv-ai/a')
      await started
      const close = h.close('syv-ai/a')
      const reopen = h.open('syv-ai/a')
      release()
      await visibleOpen
      await close
      const reopened = await reopen
      expect(h.get('syv-ai/a')).toBe(reopened)
      expect(h.active()).toBe(reopened)
    } finally {
      release()
    }
  })

  it('makes non-selecting starts wait for an admitted targeted close', async () => {
    const { registry } = await twoVaults()
    const { h } = host(registry)
    const old = await h.getOrOpen('syv-ai/a')
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const dispose = old.close.bind(old)
    old.close = async () => {
      entered()
      await gate
      await dispose()
    }
    try {
      const closing = h.close('syv-ai/a')
      await started
      const reopening = h.getOrOpen('syv-ai/a')
      expect(h.get('syv-ai/a')).toBeNull()
      release()
      await closing
      const replacement = await reopening
      expect(replacement).not.toBe(old)
      expect(h.get('syv-ai/a')).toBe(replacement)
    } finally {
      release()
      await h.closeAll().catch(() => {})
    }
  })

  it('keeps independent targeted closes from serializing globally', async () => {
    const { registry } = await twoVaults()
    const { h } = host(registry)
    const a = await h.getOrOpen('syv-ai/a')
    const b = await h.getOrOpen('syv-ai/b')
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const disposeA = a.close.bind(a)
    a.close = async () => {
      entered()
      await gate
      await disposeA()
    }
    try {
      const closingA = h.close('syv-ai/a')
      await started
      await h.close('syv-ai/b')
      expect(h.get('syv-ai/b')).toBeNull()
      expect(h.get('syv-ai/a')).toBeNull()
      release()
      await closingA
    } finally {
      release()
      await h.closeAll().catch(() => {})
    }
  })

  it('keeps non-selecting reopen ordered through visible preparation and close', async () => {
    const { registry } = await twoVaults()
    let releasePreparation!: () => void
    let enteredPreparation!: () => void
    let releaseDispose!: () => void
    let enteredDispose!: () => void
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = resolve
    })
    const preparing = new Promise<void>((resolve) => {
      enteredPreparation = resolve
    })
    const disposal = new Promise<void>((resolve) => {
      releaseDispose = resolve
    })
    const disposing = new Promise<void>((resolve) => {
      enteredDispose = resolve
    })
    let blockPreparation = false
    const h = createVaultHost({
      registry,
      claims: CLAIMS,
      beforeOpen: async () => {
        if (blockPreparation) {
          blockPreparation = false
          enteredPreparation()
          await preparation
        }
      },
      onSnapshot: () => {},
      onSyncState: () => {},
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000 },
    })
    hosts.push(h)
    try {
      const runtime = await h.getOrOpen('syv-ai/a')
      blockPreparation = true
      const runtimeDispose = runtime.close.bind(runtime)
      runtime.close = async () => {
        enteredDispose()
        await disposal
        await runtimeDispose()
      }
      const visible = h.open('syv-ai/b')
      await preparing
      const closing = h.close('syv-ai/a')
      const reopening = h.getOrOpen('syv-ai/a')
      releasePreparation()
      await visible
      await disposing
      releaseDispose()
      await closing
      const replacement = await reopening
      expect(replacement).not.toBe(runtime)
      expect(h.active()?.remote).toBe('syv-ai/b')
      expect(h.get('syv-ai/a')).toBe(replacement)
    } finally {
      releasePreparation()
      releaseDispose()
      await h.closeAll().catch(() => {})
    }
  })

  it('closeAll drains an already-running targeted close', async () => {
    const { registry } = await twoVaults()
    const { h } = host(registry)
    const runtime = await h.getOrOpen('syv-ai/a')
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const close = runtime.close.bind(runtime)
    runtime.close = async () => {
      entered()
      await gate
      await close()
    }
    try {
      const targeted = h.close('syv-ai/a')
      await started
      let allDone = false
      const all = h.closeAll().then(() => {
        allDone = true
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(allDone).toBe(false)
      release()
      await Promise.all([targeted, all])
      expect(allDone).toBe(true)
    } finally {
      release()
    }
  })

  it('isolates throwing selection replay observers and keeps the runtime closable', async () => {
    const { registry } = await twoVaults()
    const h = createVaultHost({
      registry,
      claims: CLAIMS,
      onSnapshot: () => {
        throw new Error('renderer observer failed')
      },
      onSyncState: () => {},
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000 },
    })
    hosts.push(h)
    await expect(h.open('syv-ai/a')).resolves.toMatchObject({ remote: 'syv-ai/a' })
    expect(h.active()?.remote).toBe('syv-ai/a')
    await h.close('syv-ai/a')
    expect(h.get('syv-ai/a')).toBeNull()
  })

  it('coalesces concurrent closeAll and closes remaining runtimes after one teardown fails', async () => {
    const { registry } = await twoVaults()
    const h = createVaultHost({
      registry,
      claims: CLAIMS,
      onSnapshot: () => {},
      onSyncState: () => {},
      activity: ({ message }) => {
        if (message === 'Closed syv-ai/a') throw new Error('activity failed')
      },
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000 },
    })
    hosts.push(h)
    const a = await h.getOrOpen('syv-ai/a')
    const b = await h.getOrOpen('syv-ai/b')
    const first = h.closeAll()
    const second = h.closeAll()
    expect(second).toBe(first)
    await expect(first).rejects.toThrow(/Could not close all/)
    expect(h.get('syv-ai/a')).toBeNull()
    expect(h.get('syv-ai/b')).toBeNull()
    expect(a).not.toBe(b)
  })

  it('continues teardown of every runtime when one push throws', async () => {
    const { registry } = await twoVaults()
    const h = createVaultHost({
      registry,
      claims: CLAIMS,
      onSnapshot: () => {},
      onSyncState: () => {},
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000 },
    })
    hosts.push(h)
    const a = await h.getOrOpen('syv-ai/a')
    const b = await h.getOrOpen('syv-ai/b')
    let closedA = false
    let closedB = false
    const closeA = a.close.bind(a)
    const closeB = b.close.bind(b)
    a.pushNow = async () => {
      throw new Error('push failed')
    }
    a.close = async () => {
      closedA = true
      await closeA()
    }
    b.close = async () => {
      closedB = true
      await closeB()
    }

    await expect(h.closeAll()).rejects.toThrow(/Could not close all/)
    expect(closedA).toBe(true)
    expect(closedB).toBe(true)
  })

  it('admits cold preparation once across visible and non-selecting starts', async () => {
    const { registry } = await twoVaults()
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const started = new Promise<void>((resolve) => (entered = resolve))
    let preparations = 0
    const h = createVaultHost({
      registry,
      claims: CLAIMS,
      onSnapshot: () => {},
      onSyncState: () => {},
      timings: { pullIntervalMs: 60_000, healIntervalMs: 60_000 },
    })
    hosts.push(h)
    const previous = await h.open('syv-ai/a')
    try {
      const visible = h.open('syv-ai/b', async () => {
        preparations++
        entered()
        await gate
      })
      await started
      const background = h.getOrOpen('syv-ai/b')
      expect(h.active()).toBe(previous)
      release()
      const [selected, startedRuntime] = await Promise.all([visible, background])
      expect(selected).toBe(startedRuntime)
      expect(preparations).toBe(1)
      expect(h.active()).toBe(selected)
    } finally {
      release()
      await h.closeAll().catch(() => {})
    }
  })

  it('lets independent vaults prepare without a global start lock', async () => {
    const { registry } = await twoVaults()
    const { h } = host(registry)
    hosts.push(h)
    await h.open('syv-ai/b')
    let release!: () => void
    let entered!: () => void
    let independentEntered!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const blocked = new Promise<void>((resolve) => (entered = resolve))
    const independent = new Promise<void>((resolve) => (independentEntered = resolve))
    try {
      const first = h.open('syv-ai/a', async () => {
        entered()
        await gate
      })
      await blocked
      const second = h.open('syv-ai/b', async () => independentEntered())
      await independent
      expect(h.active()?.remote).toBe('syv-ai/b')
      release()
      await Promise.all([first, second])
    } finally {
      release()
      await h.closeAll().catch(() => {})
    }
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
