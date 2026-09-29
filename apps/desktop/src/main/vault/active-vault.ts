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
import { emptyVaultSnapshot } from '@holi/shared'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { VaultSnapshot } from '@holi/shared'
import type { GitDeps, GitRepo, PullResult, RepoStatus } from '../git'
import { isIndexLockError, openRepo } from '../git'
import {
  installGitHook,
  partitionBySize,
  writeHookEndpoint,
  type HeldBackFile,
} from './large-files'
import { readMaxCommittedFileBytes } from './vault-settings'
import type { VaultRegistry } from './registry'
import { scanVault } from './vault-store'
import { watchVault, type VaultWatcher } from './watcher'

/**
 * The sync indicator's vocabulary.
 *
 * Push is automatic, so an unpushed count is information only when a push is
 * *failing*: it rides `offline` rather than a state of its own.
 *
 *   - `no-access`: a push rejected for *permission* is reported as exactly
 *     that, never dressed as a network failure.
 *   - `paused`: a vault on another branch stays open and readable while sync
 *     is off, and the user has to be told which is true.
 */
export type SyncState =
  | { kind: 'up-to-date' }
  | { kind: 'pulling' }
  | { kind: 'offline'; count: number }
  | { kind: 'no-access' }
  | { kind: 'conflict'; paths: string[] }
  | { kind: 'reconciling'; paths: string[] }
  | {
      kind: 'paused'
      reason: string
      /** True when someone asked for this pause and will lift it (the assistant
       *  holding the vault for its turn). Such a pause is news, not a warning:
       *  nothing is asked of the user and it clears itself. A pause that comes
       *  from the repo being blocked carries no flag, because it is indefinite
       *  and does want attention. */
      manual?: boolean
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
  /** Stops both loops while an agent turn holds the vault. */
  pause(reason: string): void
  resume(): void
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
  close(): Promise<void>
}

/**
 * Why sync must not run right now, or null.
 *
 * Holi refuses to sync a repo whose state it does not own, but only *sync*:
 * the vault stays open and editable, because someone on a branch or resolving
 * a merge by hand should not lose access to their notes.
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

/** `Update <path>` for one file, a count for several. Unremarkable on purpose. */
function commitMessage(paths: string[]): string {
  return paths.length === 1 ? `Update ${paths[0]}` : `Update ${paths.length} files`
}

export async function openActiveVault(args: {
  remote: string
  repo: GitRepo
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
  /** Where this vault's git hook calls back. Takes the remote so the
   *  token is minted for THIS vault: the endpoint is written into this
   *  clone's `.git/hooks`, and a shared token would let a commit here run the
   *  staged transforms against whichever vault is on screen. */
  hookEndpoint?: (remote: string) => { port: number; token: string } | null
  timings?: Partial<SyncTimings>
}): Promise<ActiveVault> {
  const timings: SyncTimings = { ...DEFAULT_TIMINGS, ...args.timings }
  const root = args.repo.root
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
  // Tell that hook how to reach us. Rewritten every open because the port is
  // ephemeral and moves on every restart; best-effort for the same reason as
  // the install above.
  await writeHookEndpoint(root, args.hookEndpoint?.(args.remote) ?? null).catch((err) =>
    console.error('[vault] hook endpoint write failed:', err),
  )

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
  let cached: VaultSnapshot = await scanVault(root)
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
      // A vault directory can vanish under us (a user deleting the clone in
      // Finder), and a throw here must not take the heal loop down with it. An
      // empty vault is the honest reading of an absent one.
      cached = await scanVault(root).catch(() => emptyVaultSnapshot())
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
   *   - Being on the wrong branch outranks progress reporting: nothing is
   *     going to happen, so an `offline` count would be a promise we do not keep.
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
      const sha = await args.repo.commitAll(commitMessage(partitioned.commit), partitioned.commit)
      await refreshState()
      if (sha !== null && !closed) args.onCommitted?.(partitioned.commit)
      // A commit that landed is work the remote does not have yet. Arm the
      // coalescer rather than pushing now, so a burst of commits (a board drag,
      // an agent turn) becomes one push. The leave points push immediately.
      if (sha !== null) schedulePush()
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
      }
      // A clean merge is silent: no notification, no dialog. The tree
      // updates itself because the merge wrote files and the watcher saw it,
      // but rescan directly too: a merge is exactly the burst most likely to
      // land inside a coalescing window.
      if (result.kind === 'merged') {
        await rescan()
        if (!closed) args.onCommitted?.(null)
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
      } else if (result.kind === 'rejected' && result.reason === 'permission') {
        permissionDenied = true
      }
      // A second non-fast-forward here (someone pushed again in the last few
      // milliseconds) is left for the next tick rather than looped on.
    } catch (err) {
      console.error('[vault] push failed:', err)
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

  return {
    remote: args.remote,
    root,
    repo: args.repo,
    snapshot: () => cached,
    syncState: () => state,
    heldBack: () => heldBack,
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
    pause(reason) {
      manualPause = reason
      setState({ kind: 'paused', reason, manual: true })
    },
    resume() {
      manualPause = null
      // The conflict pause has to go too, and this is the ONLY thing that
      // clears it. It is sticky on purpose, but sticky with no way out strands
      // the vault: no pull is ever attempted again, even once resolved.
      //
      // **Except during a reconcile**, which runs *through* the agent: the turn
      // ending is not the merge being finished, and dropping the paths here
      // would take the editor's locks off files that still hold markers. The
      // reconcile ends on its own signal — see `settleReconcile`.
      if (!reconciling) conflictPaths = null
      // Sequenced, not fired together: run concurrently, one simply loses to the
      // other's guard and silently does nothing.
      void (async () => {
        await maybeCommit()
        await maybePull()
      })()
    },
    async reconcile() {
      if (closed) return { paths: [] }
      const result = await args.repo.remerge()
      if (result.kind === 'conflict') {
        // Markers + MERGE_HEAD are now in the tree; refresh the (fresh) paths.
        conflictPaths = result.paths
        reconciling = true
        await refreshState()
        return { paths: result.paths }
      }
      // It merged clean (or was already up-to-date): clear the sticky banner and
      // return to normal. A merge commit, if any, still needs pushing.
      conflictPaths = null
      await rescan()
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
      reconciling = false
      await refreshState()
    },

    async close() {
      closed = true
      clearInterval(heal)
      clearInterval(pullTimer)
      if (commitTimer !== null) clearTimeout(commitTimer)
      commitTimer = null
      if (pushTimer !== null) clearTimeout(pushTimer)
      pushTimer = null
      await watcher.close()
      // Leave no stale port behind: a terminal commit after Holi quits would
      // otherwise spend its curl timeout on a socket nobody is listening to.
      await writeHookEndpoint(root, null).catch(() => {})
    },
  }
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
  onSnapshot: (snapshot: VaultSnapshot) => void
  onSyncState: (state: SyncState) => void
  onHeldBack?: (files: HeldBackFile[]) => void
  onCommitted?: (paths: string[] | null) => void
  /** Where this vault's git hook calls back. Takes the remote so the
   *  token is minted for THIS vault: the endpoint is written into this
   *  clone's `.git/hooks`, and a shared token would let a commit here run the
   *  staged transforms against whichever vault is on screen. Read per open:
   *  the hook server binds after the host is built, and the port moves on
   *  restart. */
  hookEndpoint?: (remote: string) => { port: number; token: string } | null
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
          onSnapshot: args.onSnapshot,
          onSyncState: args.onSyncState,
          onHeldBack: args.onHeldBack,
          onCommitted: args.onCommitted,
          hookEndpoint: args.hookEndpoint,
          timings: args.timings,
        })
        return current
      }),

    close: () => serialise(closeCurrent),
  }
}
