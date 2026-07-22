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

/** Long enough that a fire would have landed. Used for absence assertions. */
const SETTLE = 400
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
