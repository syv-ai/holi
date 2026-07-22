/**
 * The watcher, which says only *when*.
 *
 * It carries no payload on purpose (plan 4 decision 6): the snapshot is the
 * truth and a rescan is cheap, so an unaddressed "something changed" is all the
 * loop needs — and being coarse is what makes a dropped event survivable.
 *
 * These are event-bound tests, not CPU-bound. `fileParallelism: false` in
 * vitest.config.ts is what keeps them honest; read its comment before touching
 * any wait in this file. **Do not fix a flake by widening a wait.**
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { watchVault, type VaultWatcher } from '../src/main/vault/watcher'
import { cleanupFixtures, plainGit, tmp } from './helpers/git-fixtures'

afterAll(cleanupFixtures)

const DEBOUNCE = 30
/** Comfortably past the debounce — the window in which a fire must have landed
 * if it was going to. Used for *absence* assertions, where there is nothing to
 * await. */
const SETTLE = 400

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * A vault-shaped directory: a real repo, so `.git` is real too.
 *
 * **The trailing settle is load-bearing, and it is a fixture concern rather
 * than a papered-over race.** macOS delivers FSEvents for writes that happened
 * shortly *before* a watcher became ready — `ignoreInitial` suppresses
 * chokidar's own initial walk, not the OS's replay window — so building a vault
 * and watching it in the same tick makes the setup writes arrive as events.
 * Measured: 0 ms leaks one event, 50 ms is already clean, and this uses 150 ms
 * for margin.
 *
 * In production the same replay is harmless: a spurious rescan is idempotent by
 * construction (the watcher carries no payload) and the commit loop reads `git
 * status` regardless. It only matters here, where a test asserts a *count*.
 */
async function vault(): Promise<string> {
  const root = await tmp('holi-watch-')
  await plainGit(root, ['init', '-b', 'main', '.'])
  await writeFile(join(root, 'README.md'), '# Vault\n', 'utf8')
  await sleep(150)
  return root
}

/** Counts fires and lets a test await the next one. */
function recorder() {
  let count = 0
  let wake: (() => void) | null = null
  return {
    onChange: () => {
      count++
      wake?.()
      wake = null
    },
    get count() {
      return count
    },
    /** Resolves on the next fire, or rejects after `SETTLE`. */
    next(): Promise<void> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('watcher never fired')), SETTLE)
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    },
  }
}

const open: VaultWatcher[] = []
afterAll(async () => {
  for (const w of open) await w.close().catch(() => {})
})

async function start(root: string, onChange: () => void): Promise<VaultWatcher> {
  const w = await watchVault({ root, onChange, debounceMs: DEBOUNCE })
  open.push(w)
  return w
}

describe('watchVault', () => {
  it('fires when a file is added', async () => {
    const root = await vault()
    const rec = recorder()
    await start(root, rec.onChange)

    await writeFile(join(root, 'note.md'), 'hi\n', 'utf8')
    await rec.next()
    expect(rec.count).toBe(1)
  })

  it('fires when a file is changed', async () => {
    const root = await vault()
    const rec = recorder()
    await start(root, rec.onChange)

    await writeFile(join(root, 'README.md'), '# Changed\n', 'utf8')
    await rec.next()
  })

  it('fires when a file is unlinked', async () => {
    const root = await vault()
    const rec = recorder()
    await start(root, rec.onChange)

    await rm(join(root, 'README.md'))
    await rec.next()
  })

  it('fires for a file in a new subdirectory', async () => {
    const root = await vault()
    const rec = recorder()
    await start(root, rec.onChange)

    await mkdir(join(root, 'projects', 'q2'), { recursive: true })
    await writeFile(join(root, 'projects/q2/roadmap.md'), 'plans\n', 'utf8')
    await rec.next()
  })

  it('coalesces a burst into ONE call', async () => {
    // FR-5: a board drag across lanes, or an agent turn touching ten files, is
    // one commit rather than ten. The coalescing is what makes that true.
    //
    // Runs at the PRODUCTION debounce rather than this file's 30 ms, because
    // the value is the thing under test here. Measured: ten writes complete in
    // ~3 ms but chokidar delivers them as 14 events in TWO batches ~50 ms
    // apart, so a 30 ms debounce splits the burst and a 100 ms one does not.
    // The shipped 200 ms has ~4x margin over that gap — which is the reason it
    // is 200 and not 50.
    const root = await vault()
    const rec = recorder()
    const w = await watchVault({ root, onChange: rec.onChange }) // default debounce
    open.push(w)

    for (let i = 0; i < 10; i++) await writeFile(join(root, `n${i}.md`), `${i}\n`, 'utf8')
    await rec.next()
    await sleep(SETTLE)

    expect(rec.count).toBe(1)
  })

  it('does not fire for a write inside .git', async () => {
    // The load-bearing exclusion. `.git` churns on every commit Holi makes, so
    // watching it means the commit loop re-triggers itself forever — and a
    // real vault's object store is thousands of files to walk.
    const root = await vault()
    const rec = recorder()
    await start(root, rec.onChange)

    await writeFile(join(root, '.git', 'holi-probe'), 'x\n', 'utf8')
    await sleep(SETTLE)

    expect(rec.count).toBe(0)
  })

  it('does not fire for the tmp file every atomic write creates', async () => {
    // writeAtomic writes `.holi-tmp-<hex>` then renames it. If the tmp file
    // fired, every single save would cost two rescans.
    const root = await vault()
    const rec = recorder()
    await start(root, rec.onChange)

    await writeFile(join(root, '.holi-tmp-abc123'), 'x\n', 'utf8')
    await sleep(SETTLE)

    expect(rec.count).toBe(0)
  })

  it('does not fire for a machine-local file', async () => {
    // USER.md is gitignored and never syncs; a change to it is not a vault
    // change and must not produce a commit attempt.
    const root = await vault()
    const rec = recorder()
    await start(root, rec.onChange)

    await writeFile(join(root, 'USER.md'), 'about me\n', 'utf8')
    await sleep(SETTLE)

    expect(rec.count).toBe(0)
  })

  it('does not fire on startup for files that already exist', async () => {
    // Without ignoreInitial, opening a vault fires once per file in it.
    const root = await vault()
    await writeFile(join(root, 'a.md'), 'a\n', 'utf8')
    await writeFile(join(root, 'b.md'), 'b\n', 'utf8')
    await sleep(150) // see vault() — these writes must fall outside the replay window

    const rec = recorder()
    await start(root, rec.onChange)
    await sleep(SETTLE)

    expect(rec.count).toBe(0)
  })

  it('does not fire after close()', async () => {
    const root = await vault()
    const rec = recorder()
    const w = await start(root, rec.onChange)

    await w.close()
    await writeFile(join(root, 'after.md'), 'too late\n', 'utf8')
    await sleep(SETTLE)

    expect(rec.count).toBe(0)
  })

  it('drops a debounce still in flight when closed', async () => {
    // A pending timer that fires after teardown calls back into an ActiveVault
    // that has already released its repo — and the failure surfaces in an
    // unrelated test, three files later.
    const root = await vault()
    const rec = recorder()
    const w = await start(root, rec.onChange)

    await writeFile(join(root, 'racing.md'), 'x\n', 'utf8')
    await w.close() // inside the debounce window
    await sleep(SETTLE)

    expect(rec.count).toBe(0)
  })
})
