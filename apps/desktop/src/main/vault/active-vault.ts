/**
 * The open vault: one at a time, and the owner of everything that runs while a
 * vault is on screen — its `GitRepo`, its watcher, its cached snapshot, and the
 * sync loop.
 *
 * **Why one at a time.** Exactly one watcher and one set of timers exist at any
 * moment, which is what keeps a vault switch a teardown rather than a leak. The
 * cost is that a background vault neither pulls nor reports a sync state until
 * you switch to it; `VaultHost` below is the seam where an N-vault future would
 * change, and nothing outside it assumes the singleton.
 *
 * **Why not "vault session".** `GitHubSession` owns the word *session* in this
 * codebase, and it outlives every vault.
 *
 * The two rules the loop is built on, both of which cost data if broken:
 *
 *   - The watcher is a **hint**. `git status` is the truth about what needs
 *     committing, and `scanVault` is the truth about what is in the vault. A
 *     dropped filesystem event therefore delays work by one tick instead of
 *     losing it — which matters because an uncommitted file breaks FR-7's
 *     "clean between commits by construction", and a tree that is not clean is
 *     a tree the next pull cannot merge.
 *   - The snapshot push carries **no path**. Everything downstream re-derives
 *     from it, so an over-eager push is free and a missed one self-heals.
 */
import type { VaultSnapshot } from '@holi/shared'
import type { GitRepo, PullResult, PushResult } from '../git'
import { scanVault } from './vault-store'
import { watchVault, type VaultWatcher } from './watcher'

/**
 * FR-21's display vocabulary, plus two this design needs:
 *
 *   - `publishing`, because a publish is a pull *and* a push and calling it
 *     `pulling` would be a lie at the moment it matters most.
 *   - `paused`, because a vault on another branch stays open and readable while
 *     sync is off (FR-2 constrains sync, not open) and the user has to be told
 *     which of those two things is true.
 */
export type SyncState =
  | { kind: 'up-to-date' }
  | { kind: 'ahead'; count: number }
  | { kind: 'pulling' }
  | { kind: 'publishing' }
  | { kind: 'offline' }
  | { kind: 'conflict'; paths: string[] }
  | { kind: 'reconciling' }
  | { kind: 'paused'; reason: string }

export interface SyncTimings {
  /** Quiet before a rescan. Short: the file tree has to feel live. */
  rescanDebounceMs: number
  /** Quiet before the commit check. `prd/vaults-sync.md` §Open question 1. */
  commitQuietMs: number
  /** The backstop. Rescans AND commits, whatever the watcher did or did not say. */
  healIntervalMs: number
  pullIntervalMs: number
  /** So alt-tabbing does not fetch in a loop. */
  focusThrottleMs: number
}

export const DEFAULT_TIMINGS: SyncTimings = {
  rescanDebounceMs: 200,
  commitQuietMs: 3_000,
  healIntervalMs: 30_000,
  pullIntervalMs: 180_000,
  focusThrottleMs: 30_000,
}

export interface ActiveVault {
  readonly remote: string
  readonly root: string
  readonly repo: GitRepo
  /** The cache. Never touches the disk. */
  snapshot(): VaultSnapshot
  syncState(): SyncState
  /** Rescan now and push. */
  refresh(): Promise<void>
  /** Commit whatever is dirty, now — ⌘S, vault switch, quit. */
  commitNow(): Promise<string | null>
  publish(): Promise<PullResult | PushResult>
  /** Window focus (FR-9). Throttled internally. */
  onFocus(): void
  /** FR-8/FR-18: a reconcile stops both loops. */
  pause(reason: string): void
  resume(): void
  close(): Promise<void>
}

export async function openActiveVault(args: {
  remote: string
  repo: GitRepo
  onSnapshot: (snapshot: VaultSnapshot) => void
  onSyncState: (state: SyncState) => void
  timings?: Partial<SyncTimings>
}): Promise<ActiveVault> {
  const timings: SyncTimings = { ...DEFAULT_TIMINGS, ...args.timings }
  const root = args.repo.root

  let closed = false
  let cached: VaultSnapshot = await scanVault(root)
  let state: SyncState = { kind: 'up-to-date' }
  let scanning = false

  function setState(next: SyncState): void {
    // Only on a real change: the panel would otherwise re-render on every tick.
    if (JSON.stringify(next) === JSON.stringify(state)) return
    state = next
    if (!closed) args.onSyncState(next)
  }

  async function rescan(): Promise<void> {
    if (closed || scanning) return
    scanning = true
    try {
      // A vault directory can vanish under us — a user deleting the clone in
      // Finder is not hypothetical — and a throw here must not take the heal
      // loop down with it. An empty vault is the honest reading of an absent
      // one; the sync state is where the problem gets reported.
      cached = await scanVault(root).catch(() => ({ docs: [], tasks: [], broken: [] }))
      if (!closed) args.onSnapshot(cached)
    } finally {
      scanning = false
    }
  }

  const watcher: VaultWatcher = await watchVault({
    root,
    debounceMs: timings.rescanDebounceMs,
    onChange: () => void rescan(),
  })

  // The backstop. Deliberately does the same work the watcher triggers, rather
  // than something cheaper: the whole point is that it does not trust what the
  // watcher did or did not say.
  const heal = setInterval(() => void rescan(), timings.healIntervalMs)

  return {
    remote: args.remote,
    root,
    repo: args.repo,
    snapshot: () => cached,
    syncState: () => state,
    refresh: rescan,
    commitNow: () => {
      throw new Error('not implemented')
    },
    publish: () => {
      throw new Error('not implemented')
    },
    onFocus: () => {},
    pause: (reason) => setState({ kind: 'paused', reason }),
    resume: () => setState({ kind: 'up-to-date' }),
    async close() {
      closed = true
      clearInterval(heal)
      await watcher.close()
    },
  }
}
