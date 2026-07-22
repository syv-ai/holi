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
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openRepo } from '../src/main/git'
import { openActiveVault, type ActiveVault } from '../src/main/vault/active-vault'
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
async function waitFor(what: string, predicate: () => Promise<boolean> | boolean, timeoutMs = 8_000) {
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

const open: ActiveVault[] = []
afterAll(async () => {
  for (const v of open) await v.close().catch(() => {})
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
  const count = async (dir: string) =>
    Number(await plainGit(dir, ['rev-list', '--count', 'HEAD']))
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
    expect(active.syncState()).toEqual({ kind: 'paused', reason: 'reconciling' })

    active.resume()
    await writeFile(join(dir, 'after.md'), 'y\n', 'utf8')
    await waitFor('the commit after resuming', async () => (await count(dir)) === before + 1)
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
