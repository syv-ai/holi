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
import type { GitDeps, GitRepo, PullResult, PushResult, RepoStatus } from '../git'
import { openRepo } from '../git'
import type { VaultRegistry } from './registry'
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

/**
 * Why sync must not run right now, or null.
 *
 * FR-2 refuses rather than "fixing" a repo it does not own the state of — and
 * decision 11 narrows that to *sync*: the vault stays open, readable and
 * editable, because someone who checked out a branch in a terminal should not
 * lose access to their notes, and "mid-operation" includes a merge they are
 * resolving by hand, which is the moment they would most want to see them.
 *
 * `unborn` is deliberately NOT a reason: a repo `github.createRepo` just made
 * has no commits, and its first autosave has to land.
 */
function blockedReason(status: RepoStatus): string | null {
  if (status.detached) return 'detached HEAD — sync paused'
  if (status.merging) return 'a merge is in progress — sync paused'
  if (status.defaultBranch !== null && status.branch !== status.defaultBranch) {
    return `on ${status.branch}, not ${status.defaultBranch} — sync paused`
  }
  return null
}

/** FR-4: `Update <path>` for one file, a count for several. Unremarkable on
 *  purpose — these are the journal, and publishes are the landmarks. */
function commitMessage(paths: string[]): string {
  return paths.length === 1 ? `Update ${paths[0]}` : `Update ${paths.length} files`
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
  let committing = false
  let commitTimer: NodeJS.Timeout | null = null
  /** Set by `pause()` — a reconcile. Distinct from the status-derived pause,
   *  which clears itself the moment the user switches back to the branch. */
  let manualPause: string | null = null
  let syncing: 'pulling' | 'publishing' | null = null
  /** Claimed synchronously by `maybePull`. Separate from `syncing`, which is
   *  for display and is only set once a pull is really going to happen. */
  let pullInFlight = false
  let lastFocusPull = 0
  /** The last network attempt failed. A flag rather than a state, so the
   *  `finally` that clears `syncing` cannot overwrite it. */
  let offline = false
  /**
   * The conflict banner, and it is **sticky** (FR-17): ignore it and you keep
   * working on a clean tree, so it must survive every autosave commit that
   * happens while you do. Cleared only by a pull that succeeds.
   *
   * It is also what pauses auto-pull for this vault (FR-12) — without that the
   * loop retries and re-aborts the same merge every interval, forever.
   */
  let conflictPaths: string[] | null = null

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

  /**
   * The one place a sync state is decided, so the loops cannot overwrite each
   * other's answers. Order is priority order, and it is load-bearing:
   *
   *   - A reconcile outranks everything; the user asked for it.
   *   - The conflict banner outranks the ordinary states, or the next autosave
   *     commit would silently clear a banner the user has not dealt with
   *     (FR-17 — it is non-blocking, not transient).
   *   - Being on the wrong branch outranks progress reporting: nothing is
   *     going to happen, so "N to publish" would be a promise we do not keep.
   */
  function computeState(status: RepoStatus): SyncState {
    if (manualPause !== null) return { kind: 'paused', reason: manualPause }
    if (conflictPaths !== null) return { kind: 'conflict', paths: conflictPaths }
    const blocked = blockedReason(status)
    if (blocked !== null) return { kind: 'paused', reason: blocked }
    if (syncing !== null) return { kind: syncing }
    if (offline) return { kind: 'offline' }
    return status.ahead > 0 ? { kind: 'ahead', count: status.ahead } : { kind: 'up-to-date' }
  }

  async function refreshState(): Promise<void> {
    if (closed) return
    // `status()` can fail on a vault whose directory vanished; `offline` is the
    // wrong word for it, but a stale state is worse than an imprecise one.
    const status = await args.repo.status().catch(() => null)
    if (status !== null) setState(computeState(status))
  }

  /**
   * The commit half of the loop, and the place decision 8 lives.
   *
   * It asks `git status` rather than trusting what the watcher reported: a
   * dropped filesystem event then delays a commit by one heal tick instead of
   * losing it. That matters because an uncommitted file breaks FR-7's "clean
   * between commits by construction", and a tree that is not clean is a tree
   * the next pull cannot merge.
   */
  async function maybeCommit(): Promise<string | null> {
    if (closed || committing || manualPause !== null) return null
    committing = true
    try {
      const status = await args.repo.status()
      if (blockedReason(status) !== null || !status.dirty) {
        // A clean tree is not an error and must not be logged as one: an idle
        // timer on a vault nobody is touching finds one every time.
        setState(computeState(status))
        return null
      }
      const sha = await args.repo.commitAll(commitMessage(status.dirtyPaths))
      await refreshState()
      return sha
    } catch (err) {
      console.error('[vault] commit failed:', err)
      return null
    } finally {
      committing = false
    }
  }

  /**
   * Fetch and merge, if that is allowed right now.
   *
   * Returns null when it declined rather than throwing, because every caller is
   * a timer and a timer has no handler.
   */
  async function maybePull(): Promise<PullResult | null> {
    // FR-12's pause is `conflictPaths`: without it the loop re-runs the same
    // doomed merge every interval and aborts it every time.
    if (closed || pullInFlight || manualPause !== null || conflictPaths !== null) return null
    // Claimed synchronously, before the first await. Checking a guard before an
    // await and setting it after one is not a guard at all: every tick that
    // arrives while `status()` is resolving walks straight through it, and with
    // an interval shorter than a fetch that is all of them.
    pullInFlight = true
    try {
      const status = await args.repo.status().catch(() => null)
      if (status === null) return null
      if (blockedReason(status) !== null) {
        setState(computeState(status))
        return null
      }

      syncing = 'pulling'
      await refreshState()
      const result = await args.repo.pull()
      offline = false
      if (result.kind === 'conflict') conflictPaths = result.paths
      // A clean merge is silent (FR-11) — no notification, no dialog. The tree
      // updates itself because the merge wrote files and the watcher saw it,
      // but rescan directly too: a merge is exactly the burst most likely to
      // land inside a coalescing window.
      if (result.kind === 'merged') await rescan()
      return result
    } catch (err) {
      // Offline is the ordinary case here, not an exception worth shouting
      // about: a laptop on a plane hits this every interval. Recorded as a flag
      // rather than set directly, so the `finally` below cannot overwrite it.
      console.error('[vault] pull failed:', err)
      offline = true
      return null
    } finally {
      syncing = null
      pullInFlight = false
      await refreshState()
    }
  }

  function scheduleCommit(): void {
    if (closed) return
    if (commitTimer !== null) clearTimeout(commitTimer)
    commitTimer = setTimeout(() => {
      commitTimer = null
      void maybeCommit()
    }, timings.commitQuietMs)
  }

  const watcher: VaultWatcher = await watchVault({
    root,
    debounceMs: timings.rescanDebounceMs,
    onChange: () => {
      // The tree updates promptly; the commit waits for the edits to stop. Two
      // debounces off one signal, because they answer different questions.
      void rescan()
      scheduleCommit()
    },
  })

  // The backstop. Deliberately does the same work the watcher triggers, rather
  // than something cheaper: the whole point is that it does not trust what the
  // watcher did or did not say.
  const heal = setInterval(() => {
    void rescan()
    void maybeCommit()
  }, timings.healIntervalMs)

  const pullTimer = setInterval(() => void maybePull(), timings.pullIntervalMs)

  // The state the vault opens in. Without this a freshly opened vault reports
  // `up-to-date` until the first tick, which is a claim rather than a reading —
  // and FR-22 is specifically that the indicator must never say synced when it
  // is not.
  await refreshState()

  return {
    remote: args.remote,
    root,
    repo: args.repo,
    snapshot: () => cached,
    syncState: () => state,
    refresh: rescan,
    commitNow() {
      // ⌘S, a vault switch, and quit. Skips the timer entirely — FR-4 calls it
      // a real commit point rather than a placebo.
      if (commitTimer !== null) {
        clearTimeout(commitTimer)
        commitTimer = null
      }
      return maybeCommit()
    },
    async publish() {
      // FR-13/FR-14. `publish()` in the engine pulls first, so the one call
      // site cannot forget to.
      syncing = 'publishing'
      await refreshState()
      try {
        const result = await args.repo.publish()
        offline = false
        // FR-15: a conflicting pre-publish pull hands off to the reconcile path
        // with nothing pushed and the user's work local and intact.
        if (result.kind === 'conflict') conflictPaths = result.paths
        return result
      } finally {
        syncing = null
        await refreshState()
      }
    },
    onFocus() {
      // FR-9. Throttled, or every alt-tab is a fetch.
      const now = Date.now()
      if (now - lastFocusPull < timings.focusThrottleMs) return
      lastFocusPull = now
      void maybePull()
    },
    pause(reason) {
      manualPause = reason
      setState({ kind: 'paused', reason })
    },
    resume() {
      manualPause = null
      void maybeCommit()
    },
    async close() {
      closed = true
      clearInterval(heal)
      clearInterval(pullTimer)
      if (commitTimer !== null) clearTimeout(commitTimer)
      commitTimer = null
      await watcher.close()
    },
  }
}

/**
 * Which vault is open. Decision 2's "one at a time" lives here and nowhere
 * else, so this is the single seam an N-vault future would change.
 */
export interface VaultHost {
  active(): ActiveVault | null
  /** Closes the current vault first. Idempotent for the vault already open. */
  open(remote: string): Promise<ActiveVault>
  close(): Promise<void>
}

export function createVaultHost(args: {
  registry: VaultRegistry
  gitDeps?: GitDeps
  onSnapshot: (snapshot: VaultSnapshot) => void
  onSyncState: (state: SyncState) => void
  timings?: Partial<SyncTimings>
}): VaultHost {
  let current: ActiveVault | null = null
  /**
   * Opens are serialised through this chain rather than allowed to interleave.
   * Two clicks in the switcher, or a click during a slow open, would otherwise
   * run two `openActiveVault` calls and close only one — leaking the other's
   * watcher and timers for the life of the process.
   */
  let queue: Promise<unknown> = Promise.resolve()

  function serialise<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn)
    // The chain must survive a rejected open, or one bad remote wedges the
    // switcher permanently.
    queue = run.catch(() => {})
    return run
  }

  async function closeCurrent(): Promise<void> {
    if (current === null) return
    const vault = current
    current = null
    // FR-6: flush before letting go. Nothing is watching this tree once the
    // vault is closed, so a dirty file left here is one nobody will notice —
    // and a tree that is not clean is one the next pull cannot merge.
    await vault.commitNow().catch((err) => console.error('[vault] flush on switch failed:', err))
    await vault.close()
  }

  return {
    active: () => current,

    open: (remote) =>
      serialise(async () => {
        if (current?.remote === remote) return current
        await closeCurrent()

        const entry = (await args.registry.list()).find((e) => e.remote === remote)
        if (!entry) throw new Error(`no such vault: ${remote}`)

        current = await openActiveVault({
          remote,
          repo: openRepo(entry.path, args.gitDeps),
          onSnapshot: args.onSnapshot,
          onSyncState: args.onSyncState,
          timings: args.timings,
        })
        return current
      }),

    close: () => serialise(closeCurrent),
  }
}
