/**
 * The open vault: one at a time, and the owner of everything that runs while a
 * vault is on screen: its `GitRepo`, its watcher, its cached snapshot, and the
 * sync loop. See `docs/features/vaults-sync.md`.
 *
 * One at a time keeps a vault switch a teardown rather than a leak. The cost is
 * that a background vault neither pulls nor reports a sync state; `VaultHost`
 * is the only seam that assumes the singleton.
 *
 * Two rules the loop is built on, both of which cost data if broken:
 *
 *   - The watcher is a **hint**. `git status` is the truth about what needs
 *     committing and `scanVault` about what is in the vault, so a dropped event
 *     delays work by one tick instead of losing it. An uncommitted file leaves
 *     a tree the next pull cannot merge.
 *   - The snapshot push carries **no path**. Everything downstream re-derives
 *     from it, so an over-eager push is free and a missed one self-heals.
 */
import { emptyVaultSnapshot, syncLabel } from '@holi/shared'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SyncState, VaultSnapshot } from '@holi/shared'
import type { BranchList, GitDeps, GitRepo, PullResult, RepoStatus } from '../git'
import { BranchRefusedError, isIndexLockError, openRepo } from '../git'
import { errorText, type ActivityWrite } from '../activity/log'
import { installGitHook, partitionBySize, type HeldBackFile } from './large-files'
import { installMergeDrivers } from './merge-drivers'
import { readMaxCommittedFileBytes } from './vault-settings'
import type { VaultRegistry } from './registry'
import { scanVault, type ScanClaim } from './vault-store'
import { watchVault, type VaultWatcher } from './watcher'

// The sync indicator's vocabulary lives in shared, beside the words for it
// (`sync-state.ts`), so the nav and the agent's `holi sync status` agree.
// `computeState` below decides which state is in force.
export type { SyncState }

/** What a vault's open and close do to its `bridge.local.env`. */
export interface VaultBridgeEnv {
  attach(remote: string, root: string): Promise<void>
  detach(remote: string): Promise<void>
}

export interface SyncTimings {
  /** Quiet before a rescan. Short: the file tree has to feel live. */
  rescanDebounceMs: number
  /** Quiet before the commit check. `features/vaults-sync.md`. */
  commitQuietMs: number
  /** The backstop. Rescans AND commits, whatever the watcher did or did not say. */
  healIntervalMs: number
  pullIntervalMs: number
  /** So alt-tabbing does not fetch in a loop. */
  focusThrottleMs: number
  /** Quiet before a coalesced background push. Longer than the commit debounce:
   *  a landed commit is already durable on disk, so nothing is lost by batching
   *  a burst of them into one push. `features/vaults-sync.md`. */
  pushQuietMs: number
  /** How long quit and a vault switch wait for a best-effort push. The work is
   *  already committed, so an unreachable remote must never hang either. */
  pushBudgetMs: number
}

export const DEFAULT_TIMINGS: SyncTimings = {
  rescanDebounceMs: 200,
  commitQuietMs: 3_000,
  healIntervalMs: 30_000,
  pullIntervalMs: 180_000,
  focusThrottleMs: 30_000,
  pushQuietMs: 15_000,
  pushBudgetMs: 1_000,
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
  /**
   * Push local commits now, best-effort. Recovers from a non-fast-forward
   * rejection by pulling inline and retrying (a conflicting pull routes to the
   * conflict path); records `offline` on a network failure and `no-access` on a
   * permission rejection. **Never rejects** — it catches internally, so it is
   * safe to `Promise.race` against a timeout on quit and vault switch.
   */
  pushNow(): Promise<void>
  /** Window focus. Throttled internally. */
  onFocus(): void
  /**
   * Resolves true once a pull has merged or found nothing new, the first time,
   * and false if the vault closes first; never rejects. Asking starts a pull
   * when none has caught up yet. What has to see the remote's state before it
   * writes waits on this, such as the skills update on open.
   */
  caughtUp(): Promise<boolean>
  /** Stops both loops while an agent turn holds the vault. */
  pause(reason: string): void
  /** Lift the pause, then `retry`. */
  resume(): void
  /**
   * Clear a sticky conflict, then commit and pull. A conflict that is still
   * real latches again on that pull. A reconcile in progress keeps its paths:
   * it ends on its own signal.
   */
  retry(): Promise<void>
  /**
   * Re-run the merge so the conflict is back in the working tree (markers +
   * MERGE_HEAD) for the agent to resolve, and return the conflicted paths.
   * Returns `{paths:[]}` and clears the banner when the merge now applies
   * cleanly. Holds nothing: the resulting `merging` state suspends the loops
   * (`blockedReason`), and the agent's merge commit lets them resume.
   */
  reconcile(): Promise<{ paths: string[] }>
  /** Take the merge back out of the tree, returning to the state the reconcile
   *  started from: a clean tree with the conflict still waiting. */
  abandon(): Promise<void>
  /** Files the autosave held out of the last commit for being over the size cap
   *  (the large-file gate). Derived each commit tick, never stored on disk. */
  heldBack(): HeldBackFile[]
  /** When the remote last answered (a pull or a push that got through), and
   *  what the last failed attempt said, for the status bar. */
  syncInfo(): SyncInfo
  /**
   * The status bar's sync item: commit, pull, then push, now, as the loop
   * would. Declines what the loop would decline (a conflict, a pause), and
   * never throws.
   */
  syncNow(): Promise<void>
  /** The branch picker's list: local and remote branches, nothing fetched. */
  branches(): Promise<BranchList>
  /** Fetch `origin` for the picker. Debounced: a fetch in the last
   *  `FETCH_DEBOUNCE_MS`, or a pull already fetching, is enough. Never throws;
   *  offline just leaves the refs as they were. */
  fetchBranches(): Promise<void>
  /**
   * Switch the vault to another branch, or create one at HEAD (`create`).
   * Settles the tree through autosave first and holds the sync loop while git
   * switches. Refuses (`BranchRefusedError`, in words) during a conflict, a
   * reconcile, a pause or a merge, or when a file will not commit.
   */
  switchBranch(name: string, opts?: { create?: boolean }): Promise<void>
  close(): Promise<void>
}

/** How recent a fetch the branch picker accepts instead of fetching again. */
export const FETCH_DEBOUNCE_MS = 15_000
/** How long a switch waits for a commit, pull or push already running. */
const SWITCH_WAIT_MS = 5_000

/** What the status bar says about sync beyond its state. */
export interface SyncInfo {
  /** ISO instant the remote last answered a pull or a push, or null. */
  lastSyncAt: string | null
  /** The last network failure's text (scrubbed by the log), cleared by the
   *  next success. */
  lastError: string | null
}

/** A sync state as one line of the activity log, with its level. */
function stateLine(state: SyncState): { message: string; level: 'info' | 'warn' | 'error' } {
  const label = syncLabel(state)
  switch (state.kind) {
    case 'up-to-date':
      return { message: 'Sync: up to date', level: 'info' }
    case 'paused':
      return state.manual
        ? { message: `Sync paused: ${state.reason}`, level: 'info' }
        : { message: `Sync paused: ${state.reason}`, level: 'warn' }
    case 'conflict':
    case 'no-access':
      return { message: `Sync: ${label.text}`, level: 'error' }
    default:
      return { message: `Sync: ${label.text}`, level: label.tone === 'warn' ? 'warn' : 'info' }
  }
}

/**
 * Why sync must not run right now, or null.
 *
 * Holi refuses to sync a repo whose state it does not own, but only *sync*:
 * the vault stays open and editable, because someone resolving a merge by
 * hand should not lose access to their notes. Being on a branch other than
 * the default is not a reason: sync follows the checked-out branch
 * (`docs/features/vaults-sync.md`).
 *
 * `unborn` is deliberately NOT a reason: a repo `github.createRepo` just made
 * has no commits, and its first autosave has to land.
 */
function blockedReason(status: RepoStatus): string | null {
  if (status.detached) return 'detached HEAD — sync paused'
  if (status.merging) return 'a merge is in progress — sync paused'
  return null
}

/** `Update <path>` for one file, a count for several. Unremarkable on purpose. */
function commitMessage(paths: string[]): string {
  return paths.length === 1 ? `Update ${paths[0]}` : `Update ${paths.length} files`
}

export async function openActiveVault(args: {
  remote: string
  repo: GitRepo
  /** What the scanner claims in this vault, asked on every scan: the plugins
   *  it runs can change while it is open. */
  claims: () => Promise<readonly ScanClaim[]>
  onSnapshot: (snapshot: VaultSnapshot) => void
  onSyncState: (state: SyncState) => void
  /** The large-file gate's held-back set, pushed every commit tick (including
   *  empty, so a resolved file clears the surface). */
  onHeldBack?: (files: HeldBackFile[]) => void
  /**
   * History moved: the paths an autosave commit took, or null after a merged
   * pull, which may have touched any file. Whatever shows a file's last or
   * first commit refetches on it, because nothing on disk changes when a file
   * is committed, so the snapshot says nothing.
   */
  onCommitted?: (paths: string[] | null) => void
  /** A pull or a reconcile merged teammates' commits in: HEAD before and
   *  after it. What came in is the difference (a new comment that mentions
   *  you, say). A merge someone runs in a terminal is not seen. */
  onPulled?: (range: { from: string; to: string }) => void
  /** Where this vault finds the running Holi: its `bridge.local.env`. */
  bridgeEnv?: VaultBridgeEnv
  /** The activity log (`activity/log.ts`): each commit, merge, push and
   *  sync-state change, never the quiet ticks. */
  activity?: ActivityWrite
  timings?: Partial<SyncTimings>
}): Promise<ActiveVault> {
  const timings: SyncTimings = { ...DEFAULT_TIMINGS, ...args.timings }
  const root = args.repo.root
  /** One line in the activity log, about this vault. */
  function log(
    channel: 'git' | 'sync',
    level: 'info' | 'warn' | 'error',
    message: string,
    detail?: string,
  ): void {
    args.activity?.({
      channel,
      level,
      message,
      remote: args.remote,
      ...(detail === undefined ? {} : { detail }),
    })
  }
  // The size cap is a synced setting the settings pane edits while the vault is
  // open, so every commit re-reads it (`currentCap`).
  let maxCommittedFileBytes = await readMaxCommittedFileBytes(root)
  let heldBack: HeldBackFile[] = []
  // The same gate for the agent's own commits: a machine-local pre-commit hook,
  // regenerated each open so a threshold change takes effect. Best-effort: a
  // failed install must not block opening the vault.
  await installGitHook(root, maxCommittedFileBytes).catch((err) =>
    console.error('[vault] pre-commit hook install failed:', err),
  )
  // App records merge field by field, through a driver that asks us, so two
  // people editing one record do not pause sync. Machine-local and
  // best-effort, like the hook: without it git merges the text.
  await installMergeDrivers(root).catch((err) =>
    console.error('[vault] merge driver install failed:', err),
  )
  // Tell that hook, the merge driver and every command in the vault how to
  // reach us. Rewritten every open because the port is ephemeral and moves on
  // every restart; best-effort for the same reason as the install above.
  await args.bridgeEnv
    ?.attach(args.remote, root)
    .catch((err) => console.error('[vault] bridge env write failed:', err))

  /** The cap as the settings file says now. When it moved, the git hook the
   *  agent's commits go through has the old number baked in, so reinstall it. */
  async function currentCap(): Promise<number> {
    const cap = await readMaxCommittedFileBytes(root)
    if (cap !== maxCommittedFileBytes) {
      maxCommittedFileBytes = cap
      await installGitHook(root, cap).catch((err) =>
        console.error('[vault] pre-commit hook install failed:', err),
      )
    }
    return cap
  }

  let closed = false
  /** The claims the last scan ran with: the watcher watches a local file one
   *  of them takes (a private task), as it watches any note. */
  let claimed: readonly ScanClaim[] = await args.claims()
  let cached: VaultSnapshot = await scanVault(root, claimed)
  let state: SyncState = { kind: 'up-to-date' }
  let scanning = false
  let committing = false
  let commitTimer: NodeJS.Timeout | null = null
  let pushTimer: NodeJS.Timeout | null = null
  /** Set by `pause()`. Distinct from the status-derived pause,
   *  which clears itself the moment the user switches back to the branch. */
  let manualPause: string | null = null
  let syncing: 'pulling' | null = null
  /** Claimed synchronously by `maybePull`. Separate from `syncing`, which is
   *  for display and is only set once a pull is really going to happen. */
  let pullInFlight = false
  /** Claimed synchronously by `pushNow`, so two pushes cannot run one `git push`
   *  against the same refs. Its recovery pull releases this before delegating to
   *  `maybePull` (see there), which is why `maybePull`'s guard does NOT check it. */
  let pushInFlight = false
  let lastFocusPull = 0
  /** The last network attempt failed. A flag rather than a state, so the
   *  `finally` that clears `syncing` cannot overwrite it. */
  let offline = false
  /** A push was rejected because the user cannot write to the remote. Its own
   *  flag and state, because "you lost write access" and
   *  "you are offline" send someone to two entirely different places. Cleared
   *  only by a push that succeeds. */
  let permissionDenied = false
  /**
   * The conflict banner, and it is **sticky**: ignore it and you keep working
   * on a clean tree, so it must survive every autosave commit meanwhile.
   *
   * It is also what pauses auto-pull for this vault: without that the loop
   * retries and re-aborts the same merge every interval, forever.
   */
  let conflictPaths: string[] | null = null
  /** A reconcile the user asked for is running: `reconcile()` put the conflict
   *  back in the tree and it has not been finished or abandoned yet. Distinct
   *  from `conflictPaths` alone, which is also the sticky banner over a clean
   *  tree, and from a merge someone started in a terminal, which is neither. */
  let reconciling = false
  /** When the remote last answered, and the last failure's words. */
  let lastSyncAt: string | null = null
  let lastError: string | null = null
  /** When the branch picker last fetched, for its debounce. */
  let lastFetchAt = 0
  /** The last state the log was told, as its line: `pulling` comes and goes
   *  every few minutes and says nothing, so the log hears only where the
   *  state settles, and only when that differs. */
  let loggedState: string | null = null

  function noteSynced(): void {
    lastSyncAt = new Date().toISOString()
    lastError = null
  }
  /** Settles `caughtUp()`: true on the first pull that is not a conflict,
   *  false on close. */
  let settleCaughtUp: (ok: boolean) => void = () => {}
  let isCaughtUp = false
  const caughtUp = new Promise<boolean>((resolve) => {
    settleCaughtUp = (ok) => {
      isCaughtUp = true
      resolve(ok)
    }
  })
  /** HEAD when that reconcile began: what its merge brought in is the
   *  difference once it lands (`onPulled`). */
  let reconcileFrom: string | null = null

  function setState(next: SyncState): void {
    if (next.kind !== 'pulling') {
      const line = stateLine(next)
      if (line.message !== loggedState) {
        // The first reading at open is not news unless it is bad.
        if (loggedState !== null || next.kind !== 'up-to-date') {
          log('sync', line.level, line.message)
        }
        loggedState = line.message
      }
    }
    // Only on a real change: the panel would otherwise re-render on every tick.
    if (JSON.stringify(next) === JSON.stringify(state)) return
    state = next
    if (!closed) args.onSyncState(next)
  }

  async function rescan(): Promise<void> {
    if (closed || scanning) return
    scanning = true
    try {
      // A vault directory can vanish under us (a user deleting the clone in
      // Finder), and a throw here must not take the heal loop down with it. An
      // empty vault is the honest reading of an absent one.
      cached = await args
        .claims()
        .then((claims) => {
          claimed = claims
          return scanVault(root, claims)
        })
        .catch(() => emptyVaultSnapshot())
      if (!closed) args.onSnapshot(cached)
    } finally {
      scanning = false
    }
  }

  /**
   * End a reconcile once the tree is clean.
   *
   * Nothing tells Holi the agent has finished: **the merge commit is the
   * signal**, and this is the only place a fresh `status` is read on every
   * tick. Without it the vault stays latched on `conflictPaths` after the merge
   * lands, with autosave and auto-pull off.
   *
   * Only a reconcile clears this way. A sticky banner over a clean tree (the
   * aborted auto-pull) has no merge to finish, and clearing it would drop the
   * one thing telling the user a teammate's change is still waiting.
   */
  function settleReconcile(status: RepoStatus): void {
    if (!reconciling || status.merging) return
    reconciling = false
    conflictPaths = null
    // The merge landed (or was given up, and HEAD did not move): either way
    // what came in is the difference, as after a clean pull.
    const from = reconcileFrom
    reconcileFrom = null
    if (from !== null) {
      void args.repo
        .head()
        .then((to) => {
          if (to !== null && to !== from && !closed) args.onPulled?.({ from, to })
        })
        .catch((err) => console.error('[vault] head after reconcile:', err))
    }
    // The merge commit is work the remote does not have. Coalesced, not
    // immediate: the reconcile's last write may still be settling.
    schedulePush()
  }

  /**
   * The one place a sync state is decided, so the loops cannot overwrite each
   * other's answers. Order is priority order, and it is load-bearing:
   *
   *   - A reconcile outranks everything; the user asked for it.
   *   - The conflict banner outranks the ordinary states, or the next autosave
   *     commit would silently clear a banner the user has not dealt with
   *     (it is non-blocking, not transient).
   *   - Being blocked (detached, mid-merge) outranks progress reporting:
   *     nothing is going to happen, so an `offline` count would be a promise
   *     we do not keep.
   */
  function computeState(status: RepoStatus): SyncState {
    settleReconcile(status)
    if (reconciling && conflictPaths !== null) {
      return { kind: 'reconciling', paths: conflictPaths }
    }
    if (manualPause !== null) return { kind: 'paused', reason: manualPause, manual: true }
    // Being blocked outranks the conflict banner. Of the two facts, the pause
    // is the one that costs something to miss. An
    // unnoticed conflict is a teammate's change *waiting*, still there when you
    // switch back; an unnoticed pause means autosave is off and your edits are
    // piling up uncommitted while the indicator implies they are safe.
    const blocked = blockedReason(status)
    if (blocked !== null) return { kind: 'paused', reason: blocked }
    if (conflictPaths !== null) return { kind: 'conflict', paths: conflictPaths }
    if (syncing !== null) return { kind: 'pulling' }
    // A permission refusal outranks offline: it does not clear when the network
    // returns, and telling someone to check their wifi for a rights problem
    // wastes their time.
    if (permissionDenied) return { kind: 'no-access' }
    if (offline) return { kind: 'offline', count: status.ahead }
    // Resting ahead>0 is a bounded transient (the coalesced push has not fired
    // yet) and is deliberately NOT surfaced: not worth a flickering counter.
    // The count appears only when offline.
    return { kind: 'up-to-date' }
  }

  async function refreshState(): Promise<void> {
    if (closed) return
    // `status()` can fail on a vault whose directory vanished; `offline` is the
    // wrong word for it, but a stale state is worse than an imprecise one.
    const status = await args.repo.status().catch(() => null)
    if (status !== null) setState(computeState(status))
  }

  /**
   * The commit half of the loop. It asks `git status` rather than trusting the
   * watcher, so a dropped event delays a commit by one heal tick instead of
   * losing it (see the file header).
   */
  async function maybeCommit(duringPull = false): Promise<string | null> {
    if (closed || committing || manualPause !== null) return null
    /**
     * A commit must not run while a pull is merging: `git commit` and
     * `git merge` both take `.git/index.lock`, so an autosave landing inside a
     * merge fails outright and may leave the merge half-done. The pull path
     * calls this deliberately (to get a clean tree before merging) and passes
     * `duringPull`, which is safe because it is sequenced, not concurrent.
     *
     * A plain `git push` is deliberately NOT guarded against: it does not take
     * the index lock, so a commit during one just rides the next push. The
     * push's recovery *pull* does lock the index, but it sets `pullInFlight`.
     */
    if (pullInFlight && !duringPull) return null
    committing = true
    try {
      const status = await args.repo.status()
      // The large-file gate: split the dirty paths by size and commit only the
      // ones under the cap. Oversized files stay unstaged and unpushed: nothing
      // large is pushed automatically. A path with no file (a deletion) has no
      // size and always commits.
      const sizes = new Map<string, number>()
      await Promise.all(
        status.dirtyPaths.map(async (p) => {
          const size = await stat(join(root, p))
            .then((s) => s.size)
            .catch(() => null)
          if (size !== null) sizes.set(p, size)
        }),
      )
      const partitioned = partitionBySize(
        status.dirtyPaths,
        (p) => sizes.get(p) ?? null,
        await currentCap(),
      )
      heldBack = partitioned.heldBack
      // Push the surface every tick, even when empty, so a resolved file clears it.
      args.onHeldBack?.(heldBack)

      // An all-held-back tree is effectively clean: commit nothing, and let the
      // sync state read up-to-date rather than perpetually dirty (the held-back
      // files are untracked and would otherwise peg `status.dirty` forever).
      if (blockedReason(status) !== null || partitioned.commit.length === 0) {
        setState(computeState(status))
        return null
      }
      const message = commitMessage(partitioned.commit)
      const sha = await args.repo.commitAll(message, partitioned.commit)
      if (sha !== null) {
        log(
          'git',
          'info',
          `Committed ${sha.slice(0, 7)} ${message}`,
          partitioned.commit.length > 1 ? partitioned.commit.slice(0, 50).join('\n') : undefined,
        )
      }
      await refreshState()
      if (sha !== null && !closed) args.onCommitted?.(partitioned.commit)
      // A commit that landed is work the remote does not have yet. Arm the
      // coalescer rather than pushing now, so a burst of commits (a board drag,
      // an agent turn) becomes one push. The leave points push immediately.
      if (sha !== null) schedulePush()
      return sha
    } catch (err) {
      console.error('[vault] commit failed:', err)
      log('git', 'error', 'Commit failed', errorText(err))
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
    // The conflict pause is `conflictPaths`: without it the loop re-runs the
    // same doomed merge every interval and aborts it every time.
    // `committing` is part of the guard for the same reason `pullInFlight` is
    // part of the commit's: both loops run git against one index, and even a
    // `git status` refreshes (and therefore locks) it. Deferring a pull by one
    // tick costs nothing; overlapping them costs a failed command.
    if (closed || pullInFlight || committing || manualPause !== null || conflictPaths !== null) {
      return null
    }
    // Claimed synchronously, before the first await. Checking a guard before an
    // await and setting it after one is not a guard at all: every tick that
    // arrives while `status()` is resolving walks straight through it, and with
    // an interval shorter than a fetch that is all of them.
    pullInFlight = true
    try {
      let status = await args.repo.status().catch(() => null)
      if (status === null) return null
      if (blockedReason(status) !== null) {
        setState(computeState(status))
        return null
      }

      /**
       * A pull needs a clean tree, but there is always a window up to
       * `commitQuietMs` wide where an edit is on disk and not yet committed,
       * and a pull tick can land inside it. `git merge` then refuses outright
       * ("your local changes would be overwritten"), which surfaces as a
       * **conflict with an empty path list**. Committing first avoids that.
       */
      if (status.dirty) {
        await maybeCommit(true)
        status = await args.repo.status().catch(() => null)
        // Still dirty means something declined to commit it (a reconcile, a
        // detached HEAD). Leave the pull for a later tick rather than making
        // git refuse it.
        if (status === null || status.dirty) return null
      }

      syncing = 'pulling'
      await refreshState()
      const result = await args.repo.pull()
      offline = false
      noteSynced()
      if (result.kind !== 'conflict') settleCaughtUp(true)
      if (result.kind === 'conflict') {
        /**
         * **A conflict naming no paths is not a conflict.**
         *
         * `git merge` reports unmerged paths only once it has started merging.
         * When it refuses up front (the tree changed between the check above and
         * the merge, i.e. someone typed) this comes back as
         * `{kind:'conflict', paths:[]}`.
         *
         * Latching the sticky conflict pause on that would disable auto-pull
         * *permanently* for a conflict no reconcile can resolve. Treat it as
         * transient and try again on the next tick.
         */
        if (result.paths.length === 0) return null
        conflictPaths = result.paths
        log(
          'git',
          'error',
          `Merge conflict in ${result.paths.length} file${result.paths.length === 1 ? '' : 's'}; merge aborted`,
          result.paths.join('\n'),
        )
      }
      // A clean merge is silent: no notification, no dialog. The tree
      // updates itself because the merge wrote files and the watcher saw it,
      // but rescan directly too: a merge is exactly the burst most likely to
      // land inside a coalescing window.
      if (result.kind === 'merged') {
        log(
          'git',
          'info',
          `Pulled and merged ${result.commits} commit${result.commits === 1 ? '' : 's'} from origin`,
        )
        await rescan()
        if (!closed) {
          args.onCommitted?.(null)
          args.onPulled?.({ from: result.from, to: result.to })
        }
        // A merge writes a merge commit, which the remote does not have. Push
        // it, coalesced rather than immediate because we are inside the pull's
        // `pullInFlight` guard here; `pushNow` would decline until it clears.
        schedulePush()
      }
      return result
    } catch (err) {
      // Offline is the ordinary case here, not an exception worth shouting
      // about: a laptop on a plane hits this every interval. Recorded as a flag
      // rather than set directly, so the `finally` below cannot overwrite it.
      console.error('[vault] pull failed:', err)
      // Most failures here really are the network, but a lock the user's own git
      // held briefly is not. Calling it offline sends someone to look at their
      // wifi for a problem that ended before they looked.
      const text = errorText(err)
      // Logged when it starts failing, or fails differently: a laptop on a
      // plane fails every interval, and that is one line, not forty.
      if (text !== lastError) log('git', 'warn', 'Pull failed', text)
      lastError = text
      if (!isIndexLockError(err)) offline = true
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

  /** Coalesce a burst of commits into one background push. Re-armed on every
   *  landed commit, so continuous typing pushes a handful of times rather than
   *  once per idle debounce. */
  function schedulePush(): void {
    if (closed) return
    if (pushTimer !== null) clearTimeout(pushTimer)
    pushTimer = setTimeout(() => {
      pushTimer = null
      void pushNow()
    }, timings.pushQuietMs)
  }

  /**
   * Push local commits now, best-effort. Called by the coalescer, the leave
   * points (⌘S, vault switch, quit), and after coming back to the app.
   *
   * The failure taxonomy is the whole point:
   *   - **non-fast-forward** → pull inline, then retry once. A conflicting pull
   *     routes into the existing conflict path via `maybePull`.
   *   - **network** → `offline`; the coalescer, focus and the pull loop retry.
   *   - **permission** → `no-access`, never dressed as offline.
   *
   * Never throws: every path is caught, so quit and vault switch can race it
   * against a timeout without risking an unhandled rejection.
   */
  async function pushNow(): Promise<void> {
    // A reconcile owns the tree; a sticky conflict means the remote has moved
    // under us and only a reconcile clears it. Pushing into either is wrong.
    if (closed || manualPause !== null || conflictPaths !== null) return
    // Single-flight against itself, the pull loop, and a commit, all of which
    // touch refs or the index. Claimed synchronously, before the first await.
    if (pushInFlight || pullInFlight || committing) return
    pushInFlight = true
    try {
      let result = await args.repo.push()
      if (result.kind === 'rejected' && result.reason === 'non-fast-forward') {
        log('git', 'info', 'Push rejected: the remote moved, pulling first')
        // The remote moved. Release the push guard so `maybePull`'s own
        // synchronous claim of `pullInFlight` can take over. There is no await
        // between here and that claim, so no other push can slip through the gap.
        pushInFlight = false
        const pulled = await maybePull()
        // Anything but a clean merge (a conflict, or a declined tick) is now
        // owned by `maybePull`'s state. Do not retry or the state fights it.
        if (pulled?.kind !== 'merged') return
        pushInFlight = true
        result = await args.repo.push()
      }
      if (result.kind === 'pushed' || result.kind === 'nothing-to-push') {
        offline = false
        permissionDenied = false
        noteSynced()
        if (result.kind === 'pushed') {
          log(
            'git',
            'info',
            `Pushed ${result.commits} commit${result.commits === 1 ? '' : 's'} to origin/${result.branch}`,
          )
        }
      } else if (result.kind === 'rejected' && result.reason === 'permission') {
        if (!permissionDenied) {
          log('git', 'error', 'Push refused: no write access to the repository')
        }
        permissionDenied = true
        lastError = 'no write access'
      }
      // A second non-fast-forward here (someone pushed again in the last few
      // milliseconds) is left for the next tick rather than looped on.
    } catch (err) {
      console.error('[vault] push failed:', err)
      const text = errorText(err)
      if (text !== lastError) log('git', 'error', 'Push failed', text)
      lastError = text
      // Mirrors `maybePull`: a lock the user's own git briefly held is contention,
      // not the network, and calling it offline sends someone to check their wifi.
      if (!isIndexLockError(err)) offline = true
    } finally {
      pushInFlight = false
      await refreshState()
    }
  }

  const watcher: VaultWatcher = await watchVault({
    root,
    debounceMs: timings.rescanDebounceMs,
    watches: (rel) => rel.endsWith('.md') && claimed.some((c) => c.match(rel)),
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

  /**
   * A vault can be dirty the moment it opens, and nothing will report it.
   *
   * Seeding writes `AGENTS.md` and friends *before* this function is called, so
   * no filesystem event fires for them; a session that quit mid-edit reopens
   * the same way. Without this the tree would sit uncommitted, and
   * unmergeable, for up to a whole heal interval.
   *
   * This also establishes the opening sync state as a reading, not a claim:
   * the indicator must never say synced when it is not.
   */
  await maybeCommit()

  /**
   * Announce the opening state, whatever it turned out to be.
   *
   * Unconditional rather than routed through `setState`, which pushes only on
   * a change: a fresh vault starts at `up-to-date`, and the renderer holds one
   * sync state for the whole app, so an equal value is exactly the case that
   * needs sending. The renderer's copy belongs to the previous vault.
   */
  if (!closed) args.onSyncState(state)

  // Drain anything a killed quit or a prior offline session left unpushed. The
  // opening `maybeCommit` above may also have just committed a dirty-on-open
  // tree; either way, get it to the remote. Fire-and-forget: an unreachable
  // remote must not delay the vault being usable.
  void pushNow()

  const api: ActiveVault = {
    remote: args.remote,
    root,
    repo: args.repo,
    snapshot: () => cached,
    syncState: () => state,
    heldBack: () => heldBack,
    syncInfo: () => ({ lastSyncAt, lastError }),
    async syncNow() {
      if (closed) return
      // Sequenced like `retry`, so one step does not lose to another's guard.
      // Unlike `retry`, a sticky conflict stays: only Try again clears it.
      try {
        if (commitTimer !== null) {
          clearTimeout(commitTimer)
          commitTimer = null
        }
        await maybeCommit()
        await maybePull()
        await pushNow()
      } catch (err) {
        console.error('[vault] sync now failed:', err)
      }
    },
    branches: () => args.repo.branches(),
    async fetchBranches() {
      // A pull is fetching right now, and that fetch is the fresh refs.
      if (closed || pullInFlight || Date.now() - lastFetchAt < FETCH_DEBOUNCE_MS) return
      lastFetchAt = Date.now()
      await args.repo.fetch().catch((err) => {
        // Offline is ordinary here; the picker lists what it already knows.
        console.error('[vault] branch fetch failed:', err)
        lastFetchAt = 0
      })
    },
    async switchBranch(name, opts = {}) {
      if (closed) throw new BranchRefusedError('The vault is closing')
      // In the order the sync item would name them, and refused in words: each
      // is a state the person has to finish before the tree can change.
      if (reconciling) {
        throw new BranchRefusedError('A reconcile is in progress. Finish or abandon it first.')
      }
      if (conflictPaths !== null) {
        throw new BranchRefusedError('A merge conflict is waiting. Resolve it before switching.')
      }
      if (manualPause !== null) {
        throw new BranchRefusedError(`Sync is paused (${manualPause}). Switch when it resumes.`)
      }
      const before = await args.repo.status()
      const blocked = blockedReason(before)
      if (blocked !== null) {
        throw new BranchRefusedError(
          before.detached
            ? 'HEAD is detached. Check out a branch from the terminal first.'
            : 'A merge is in progress. Finish or abort it first.',
        )
      }
      // A commit, pull or push already running finishes first rather than
      // having the tree change under it.
      const deadline = Date.now() + SWITCH_WAIT_MS
      while (pullInFlight || pushInFlight || committing) {
        if (Date.now() > deadline) {
          throw new BranchRefusedError('Sync is busy. Try again in a moment.')
        }
        await new Promise((r) => setTimeout(r, 50))
      }
      // The switch holds the loop exactly as a pull does: the commit below
      // runs inside the hold (`duringPull`), and every other commit, pull,
      // push and focus pull declines until the new tree is in place.
      pullInFlight = true
      try {
        if (commitTimer !== null) {
          clearTimeout(commitTimer)
          commitTimer = null
        }
        // Settle the tree the way autosave does, size gate and hooks included.
        await maybeCommit(true)
        try {
          await args.repo.switchBranch(name, opts)
        } catch (err) {
          if (!(err instanceof BranchRefusedError)) {
            log('git', 'error', `Could not switch to ${name}`, errorText(err))
          }
          throw err
        }
        log('git', 'info', opts.create ? `Created branch ${name}` : `Switched to branch ${name}`)
      } finally {
        pullInFlight = false
      }
      // Everything after is what a merged pull does: the tree moved under the
      // vault, so rescan, tell history, and read the state again.
      await rescan()
      if (!closed) args.onCommitted?.(null)
      await refreshState()
      // A branch that already has commits origin lacks gets them pushed.
      schedulePush()
    },
    refresh: rescan,
    commitNow() {
      // ⌘S, a vault switch, and quit. Skips the timer entirely: a real commit
      // point rather than a placebo.
      if (commitTimer !== null) {
        clearTimeout(commitTimer)
        commitTimer = null
      }
      return maybeCommit()
    },
    pushNow,
    onFocus() {
      // A fetch is already running, so this focus needs neither a pull nor a
      // throttle window of its own. Checked before stamping, or a focus that
      // did nothing would buy a whole throttle window of silence.
      if (pullInFlight) return
      // Throttled, or every alt-tab is a fetch.
      const now = Date.now()
      if (now - lastFocusPull < timings.focusThrottleMs) return
      lastFocusPull = now
      // Pull, then drain the backlog: coming back to the app is exactly when an
      // offline session's unpushed commits should leave. `pushNow` declines
      // while the pull is in flight, hence the chain.
      void maybePull().then(() => pushNow())
    },
    caughtUp() {
      // A declined pull leaves it waiting: the next tick or focus tries again.
      if (!isCaughtUp && !closed) void maybePull().then(() => pushNow())
      return caughtUp
    },
    pause(reason) {
      manualPause = reason
      setState({ kind: 'paused', reason, manual: true })
    },
    resume() {
      manualPause = null
      void api.retry().catch((err) => console.error('[vault] retry failed:', err))
    },
    async retry() {
      // The conflict pause has to go, and this (a turn ending, or "Try
      // again") is the only thing that clears it. It is sticky on purpose, but
      // sticky with no way out strands the vault: no pull is ever attempted
      // again, even once resolved. The pull below latches it again if the
      // conflict is still real.
      //
      // **Except during a reconcile**, which runs *through* the agent: the turn
      // ending is not the merge being finished, and dropping the paths here
      // would take the editor's locks off files that still hold markers. The
      // reconcile ends on its own signal — see `settleReconcile`.
      if (!reconciling) conflictPaths = null
      // Sequenced, not fired together: run concurrently, one simply loses to the
      // other's guard and silently does nothing.
      await maybeCommit()
      await maybePull()
      await refreshState()
    },
    async reconcile() {
      if (closed) return { paths: [] }
      const from = await args.repo.head().catch(() => null)
      const result = await args.repo.remerge()
      if (result.kind === 'conflict') {
        log(
          'git',
          'info',
          `Reconciling ${result.paths.length} conflicted file${result.paths.length === 1 ? '' : 's'}`,
          result.paths.join('\n'),
        )
        // Markers + MERGE_HEAD are now in the tree; refresh the (fresh) paths.
        conflictPaths = result.paths
        reconciling = true
        reconcileFrom = from
        await refreshState()
        return { paths: result.paths }
      }
      // It merged clean (or was already up-to-date): clear the sticky banner and
      // return to normal. A merge commit, if any, still needs pushing.
      conflictPaths = null
      await rescan()
      if (result.kind === 'merged' && !closed) {
        args.onPulled?.({ from: result.from, to: result.to })
      }
      schedulePush()
      await refreshState()
      return { paths: [] }
    },
    /**
     * The reconcile's escape hatch.
     *
     * `git merge --abort` returns the tree to the commit the reconcile started
     * from, so nothing is at risk, and the conflict it was called on is still
     * a conflict, which is why this restores the banner rather than clearing
     * it. Clearing would report a teammate's waiting change as dealt with.
     */
    async abandon() {
      if (closed || !reconciling) return
      await args.repo.abortMerge()
      log('git', 'info', 'Merge abandoned: the conflict is waiting again')
      reconciling = false
      reconcileFrom = null
      await refreshState()
    },

    async close() {
      closed = true
      settleCaughtUp(false)
      clearInterval(heal)
      clearInterval(pullTimer)
      if (commitTimer !== null) clearTimeout(commitTimer)
      commitTimer = null
      if (pushTimer !== null) clearTimeout(pushTimer)
      pushTimer = null
      await watcher.close()
      // Leave no stale port behind: a terminal commit after Holi quits would
      // otherwise spend its curl timeout on a socket nobody is listening to.
      await args.bridgeEnv?.detach(args.remote).catch(() => {})
    },
  }
  return api
}

/**
 * Which vault is open. "One at a time" lives here and nowhere else, so this is
 * the single seam an N-vault future would change.
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
  /** What the scanner claims in the vault at `root` (`openActiveVault`). */
  claims: (root: string) => Promise<readonly ScanClaim[]>
  onSnapshot: (snapshot: VaultSnapshot) => void
  onSyncState: (state: SyncState) => void
  onHeldBack?: (files: HeldBackFile[]) => void
  onCommitted?: (paths: string[] | null) => void
  /** A pull merged commits into the open vault `remote`, at `root`. */
  onPulled?: (vault: { remote: string; root: string }, range: { from: string; to: string }) => void
  /** Writes each opened vault's `bridge.local.env`, and deletes it when the
   *  vault closes (`bridge/env-file.ts`). */
  bridgeEnv?: VaultBridgeEnv
  /** The activity log, handed to each vault it opens. */
  activity?: ActivityWrite
  /**
   * Let go of whatever is running against this vault, before it closes.
   *
   * The agent's sessions are the reason it exists. `VaultHost` holds
   * exactly one `ActiveVault`, so a session left running in the vault being
   * closed has no repo, no watcher and no sync loop behind it; and its teardown
   * resumes the sync loop and may take a settle commit, both of which have to
   * land in the vault it actually ran in. So this is awaited while that vault is
   * still `active()`, ahead of the flush.
   *
   * Not called on a re-open of the vault that is already open: that is the
   * renderer asking for a fresh picture, not a switch.
   */
  onLeave?: () => Promise<void>
  timings?: Partial<SyncTimings>
}): VaultHost {
  let current: ActiveVault | null = null
  /**
   * Opens are serialised through this chain rather than allowed to interleave.
   * Two clicks in the switcher, or a click during a slow open, would otherwise
   * run two `openActiveVault` calls and close only one, leaking the other's
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

  /** The switch/quit push budget, shared with the vault's own timings so a test
   *  can shrink it. `pushNow` never rejects, so the race only guards latency. */
  const pushBudgetMs = args.timings?.pushBudgetMs ?? DEFAULT_TIMINGS.pushBudgetMs

  async function closeCurrent(): Promise<void> {
    if (current === null) return
    // First, and while this vault is still the active one: see `onLeave`.
    await args.onLeave?.().catch((err) => console.error('[vault] leave hook failed:', err))
    const vault = current
    current = null
    args.activity?.({ channel: 'sync', message: `Closed ${vault.remote}`, remote: vault.remote })
    // Flush before letting go. Nothing is watching this tree once the vault is
    // closed, and a tree that is not clean is one the next pull cannot merge.
    await vault.commitNow().catch((err) => console.error('[vault] flush on switch failed:', err))
    // A vault switch is a leave point: get the just-committed work to the remote
    // before this vault stops running. Budgeted, because switching must not hang
    // on an unreachable remote: the work is committed on disk regardless, and
    // the next open of this vault drains whatever did not make it out.
    await Promise.race([vault.pushNow(), new Promise((r) => setTimeout(r, pushBudgetMs))])
    await vault.close()
  }

  return {
    active: () => current,

    open: (remote) =>
      serialise(async () => {
        if (current?.remote === remote) {
          // Idempotent, but not silent. Re-opening the vault that is already
          // open is how the renderer asks for a fresh picture of it (after its
          // own reload, say); silence would leave it showing another vault's
          // state or an empty atom's `up-to-date`.
          args.onSyncState(current.syncState())
          return current
        }
        await closeCurrent()

        const entry = (await args.registry.list()).find((e) => e.remote === remote)
        if (!entry) throw new Error(`no such vault: ${remote}`)

        current = await openActiveVault({
          remote,
          repo: openRepo(entry.path, args.gitDeps),
          claims: () => args.claims(entry.path),
          onSnapshot: args.onSnapshot,
          onSyncState: args.onSyncState,
          onHeldBack: args.onHeldBack,
          onCommitted: args.onCommitted,
          onPulled: (range) => args.onPulled?.({ remote, root: entry.path }, range),
          bridgeEnv: args.bridgeEnv,
          ...(args.activity === undefined ? {} : { activity: args.activity }),
          timings: args.timings,
        })
        args.activity?.({ channel: 'sync', message: `Opened ${remote}`, remote })
        return current
      }),

    close: () => serialise(closeCurrent),
  }
}
