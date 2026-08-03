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
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { VaultSnapshot } from '@holi/shared'
import type { GitDeps, GitRepo, PullResult, RepoStatus } from '../git'
import { isIndexLockError, openRepo } from '../git'
import { partitionBySize, type HeldBackFile } from './large-files'
import { readMaxCommittedFileBytes } from './vault-settings'
import type { VaultRegistry } from './registry'
import { scanVault } from './vault-store'
import { watchVault, type VaultWatcher } from './watcher'

/**
 * FR-21's display vocabulary.
 *
 * Push is automatic (`prd/vaults-sync.md` §Pushing), so there is no `publishing`
 * state and no resting "N to publish": the remote is current within seconds by
 * design, and an unpushed count is information only when a push is *failing*.
 * That is why the count rides `offline` rather than a state of its own —
 *
 *   - `offline` carries `count` because the one time unpushed commits matter is
 *     when the network is gone and they are piling up; FR-22 forbids saying
 *     "synced" then, and a bare "offline" hides how much is waiting.
 *   - `no-access`, because FR-16 requires a push rejected for *permission* to be
 *     reported as exactly that, never dressed as a network failure.
 *   - `paused`, because a vault on another branch stays open and readable while
 *     sync is off (FR-2 constrains sync, not open) and the user has to be told
 *     which of those two things is true.
 */
export type SyncState =
  | { kind: 'up-to-date' }
  | { kind: 'pulling' }
  | { kind: 'offline'; count: number }
  | { kind: 'no-access' }
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
  /** Quiet before a coalesced background push. Longer than the commit debounce:
   *  a landed commit is already durable on disk, so nothing is lost by batching
   *  a burst of them into one push. `prd/vaults-sync.md` §Pushing. */
  pushQuietMs: number
  /** How long quit and a vault switch will wait for a best-effort push before
   *  giving up — the work is already committed, so an unreachable remote must
   *  never hang either. Mirrors the flush-on-quit courtesy budget. */
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
  /** Window focus (FR-9). Throttled internally. */
  onFocus(): void
  /** FR-8/FR-18: a reconcile stops both loops. */
  pause(reason: string): void
  resume(): void
  /**
   * FR-18 reconcile: re-run the merge so the conflict is back in the working
   * tree (markers + MERGE_HEAD) for the agent to resolve, and return the
   * currently-conflicted paths for the seed prompt. Returns `{paths:[]}` when the
   * merge now applies cleanly (the conflict resolved itself) — the banner is then
   * cleared. Holds nothing: the resulting `merging` state suspends the loops
   * (`blockedReason`), and the agent's merge commit lets them resume on their own.
   */
  reconcile(): Promise<{ paths: string[] }>
  /** Files the autosave held out of the last commit for being over the size cap
   *  (the large-file gate). Derived each commit tick, never stored on disk. */
  heldBack(): HeldBackFile[]
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
  /** The large-file gate's held-back set, pushed every commit tick (including
   *  empty, so a resolved file clears the surface). */
  onHeldBack?: (files: HeldBackFile[]) => void
  timings?: Partial<SyncTimings>
}): Promise<ActiveVault> {
  const timings: SyncTimings = { ...DEFAULT_TIMINGS, ...args.timings }
  const root = args.repo.root
  // The size cap is a per-vault synced setting, read once at open (a config
  // change takes effect on the next open — same as the seeded pre-commit hook).
  const maxCommittedFileBytes = await readMaxCommittedFileBytes(root)
  let heldBack: HeldBackFile[] = []

  let closed = false
  let cached: VaultSnapshot = await scanVault(root)
  let state: SyncState = { kind: 'up-to-date' }
  let scanning = false
  let committing = false
  let commitTimer: NodeJS.Timeout | null = null
  let pushTimer: NodeJS.Timeout | null = null
  /** Set by `pause()` — a reconcile. Distinct from the status-derived pause,
   *  which clears itself the moment the user switches back to the branch. */
  let manualPause: string | null = null
  let syncing: 'pulling' | null = null
  /** Claimed synchronously by `maybePull`. Separate from `syncing`, which is
   *  for display and is only set once a pull is really going to happen. */
  let pullInFlight = false
  /** Claimed synchronously by `pushNow`, so two pushes cannot run one `git push`
   *  against the same refs. Its recovery pull releases this before delegating to
   *  `maybePull` (see there) — that is why `maybePull`'s guard does NOT check it. */
  let pushInFlight = false
  let lastFocusPull = 0
  /** The last network attempt failed. A flag rather than a state, so the
   *  `finally` that clears `syncing` cannot overwrite it. */
  let offline = false
  /** A push was rejected because the user cannot write to the remote (FR-16).
   *  Its own flag, and its own state, because "you lost write access" and
   *  "you are offline" send someone to two entirely different places. Cleared
   *  only by a push that succeeds. */
  let permissionDenied = false
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
      cached = await scanVault(root).catch(() => ({ docs: [], tasks: [], broken: [], files: [], dirs: [] }))
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
   *     going to happen, so an `offline` count would be a promise we do not keep.
   */
  function computeState(status: RepoStatus): SyncState {
    if (manualPause !== null) return { kind: 'paused', reason: manualPause }
    // Being blocked outranks the conflict banner, which is not the order it was
    // written in — running the app showed a vault on a feature branch still
    // announcing a conflict, as though it were otherwise working normally.
    //
    // Of the two facts, the pause is the one that costs something to miss. An
    // unnoticed conflict is a teammate's change *waiting*, still there when you
    // switch back; an unnoticed pause means autosave is off and your edits are
    // piling up uncommitted while the indicator implies they are safe.
    const blocked = blockedReason(status)
    if (blocked !== null) return { kind: 'paused', reason: blocked }
    if (conflictPaths !== null) return { kind: 'conflict', paths: conflictPaths }
    if (syncing !== null) return { kind: 'pulling' }
    // A permission refusal outranks offline: it does not clear when the network
    // returns, and telling someone to check their wifi for a rights problem
    // wastes exactly the time FR-16 exists to save.
    if (permissionDenied) return { kind: 'no-access' }
    if (offline) return { kind: 'offline', count: status.ahead }
    // Resting ahead>0 is a bounded transient — the coalesced push has not fired
    // yet — and is deliberately NOT surfaced (FR-22 is about not lying, and
    // "not synced for the next few seconds" while a push is queued is not a
    // state worth a flickering counter). The count appears only when offline.
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
   * The commit half of the loop, and the place decision 8 lives.
   *
   * It asks `git status` rather than trusting what the watcher reported: a
   * dropped filesystem event then delays a commit by one heal tick instead of
   * losing it. That matters because an uncommitted file breaks FR-7's "clean
   * between commits by construction", and a tree that is not clean is a tree
   * the next pull cannot merge.
   */
  async function maybeCommit(duringPull = false): Promise<string | null> {
    if (closed || committing || manualPause !== null) return null
    /**
     * A commit must not run while a pull is merging.
     *
     * They had separate guards, which is not enough: `git commit` and
     * `git merge` both take `.git/index.lock`, so an autosave landing inside a
     * merge fails outright — and the merge it collided with may be left
     * half-done. The pull path calls this deliberately (to satisfy FR-7 before
     * merging) and passes `duringPull`, which is the one case that is safe
     * because it is sequenced rather than concurrent.
     *
     * A plain `git push` is deliberately NOT guarded against here: it does not
     * take the index lock, so a commit landing during one is safe (the commit
     * just rides the next push). The push's recovery *pull* does lock the index,
     * but it sets `pullInFlight` — which this already respects — so that case is
     * covered without blocking a commit during an ordinary push.
     */
    if (pullInFlight && !duringPull) return null
    committing = true
    try {
      const status = await args.repo.status()
      // The large-file gate: split the dirty paths by size and commit only the
      // ones under the cap. Oversized files stay unstaged and unpushed — nothing
      // large auto-publishes (fear (c)). Stat the working tree once; a path with
      // no file (a deletion) has no size and always commits.
      const sizes = new Map<string, number>()
      await Promise.all(
        status.dirtyPaths.map(async (p) => {
          const size = await stat(join(root, p)).then((s) => s.size).catch(() => null)
          if (size !== null) sizes.set(p, size)
        }),
      )
      const partitioned = partitionBySize(
        status.dirtyPaths,
        (p) => sizes.get(p) ?? null,
        maxCommittedFileBytes,
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
    // FR-12's pause is `conflictPaths`: without it the loop re-runs the same
    // doomed merge every interval and aborts it every time.
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
       * A pull needs a clean tree, and "clean between commits" (FR-7) is a
       * statement about the gaps, not about every instant: there is always a
       * window up to `commitQuietMs` wide where an edit is on disk and not yet
       * committed, and a pull tick can land inside it.
       *
       * `git merge` then refuses outright rather than conflicting — "your local
       * changes would be overwritten" — and because no merge ever starts there
       * are no unmerged paths to report, so it surfaces as a **conflict with an
       * empty path list**: a banner naming nothing, for a conflict that does not
       * exist. Committing first is what FR-7 is for.
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
         * `git merge` reports unmerged paths only once it has actually started
         * merging. When it refuses up front — overwhelmingly because the working
         * tree changed between the check above and the merge itself, i.e. someone
         * typed — there are no unmerged paths and this comes back as
         * `{kind:'conflict', paths:[]}`.
         *
         * Latching FR-12's pause on that would be severe: it is sticky by design,
         * so a user who happened to be typing while a pull was in flight would
         * have auto-pull disabled *permanently*, for a conflict that does not
         * exist and that no reconcile can resolve. Treat it as the transient
         * failure it is and try again on the next tick.
         */
        if (result.paths.length === 0) return null
        conflictPaths = result.paths
      }
      // A clean merge is silent (FR-11) — no notification, no dialog. The tree
      // updates itself because the merge wrote files and the watcher saw it,
      // but rescan directly too: a merge is exactly the burst most likely to
      // land inside a coalescing window.
      if (result.kind === 'merged') {
        await rescan()
        // A merge writes a merge commit, which the remote does not have — push
        // it. Coalesced rather than immediate because we are inside the pull's
        // `pullInFlight` guard here; `pushNow` would decline until it clears.
        schedulePush()
      }
      return result
    } catch (err) {
      // Offline is the ordinary case here, not an exception worth shouting
      // about: a laptop on a plane hits this every interval. Recorded as a flag
      // rather than set directly, so the `finally` below cannot overwrite it.
      console.error('[vault] pull failed:', err)
      // Every failure in this block lands here, and most of them really are the
      // network — but a lock the user's own git held for 200 ms is not, and it
      // survived five retries only because something is genuinely busy. FR-16
      // makes this point about push: a permission failure must never be dressed
      // as a network one. The inverse costs just as much, sending someone to
      // look at their wifi for a problem that ended before they looked.
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
   *  once per idle debounce. `prd/vaults-sync.md` §Pushing. */
  function schedulePush(): void {
    if (closed) return
    if (pushTimer !== null) clearTimeout(pushTimer)
    pushTimer = setTimeout(() => {
      pushTimer = null
      void pushNow()
    }, timings.pushQuietMs)
  }

  /**
   * Push local commits now, best-effort — the automatic replacement for the old
   * Publish (`prd/vaults-sync.md` §Pushing). Called by the coalescer, the leave
   * points (⌘S, vault switch, quit), and after coming back to the app.
   *
   * The failure taxonomy is the whole point (D61):
   *   - **non-fast-forward** → optimistic recovery: pull inline, then retry once.
   *     A conflicting pull routes into the existing conflict path via `maybePull`
   *     — a push rejection is just one more way to discover a conflict.
   *   - **network** → `offline`; the coalescer, focus and the pull loop retry.
   *   - **permission** → `no-access` (FR-16), never dressed as offline.
   *
   * Never throws: every path is caught, so quit and vault switch can race it
   * against a timeout without risking an unhandled rejection.
   */
  async function pushNow(): Promise<void> {
    // A reconcile owns the tree; a sticky conflict means the remote has moved
    // under us and only a reconcile clears it — pushing into either is wrong.
    if (closed || manualPause !== null || conflictPaths !== null) return
    // Single-flight against itself, the pull loop, and a commit — all of which
    // touch refs or the index. Claimed synchronously, before the first await.
    if (pushInFlight || pullInFlight || committing) return
    pushInFlight = true
    try {
      let result = await args.repo.push()
      if (result.kind === 'rejected' && result.reason === 'non-fast-forward') {
        // The remote moved. Release the push guard so `maybePull`'s own
        // synchronous claim of `pullInFlight` can take over — there is no await
        // between here and that claim, so no other push can slip through the gap.
        pushInFlight = false
        const pulled = await maybePull()
        // Anything but a clean merge (a conflict, or a declined tick) is now
        // owned by `maybePull`'s state — do not retry or the state fights it.
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
   * no filesystem event ever fires for them; a session that quit mid-edit
   * reopens the same way. With the commit driven only by the watcher and the
   * heal tick, the first open of every adopted repo therefore left the tree
   * uncommitted — and unmergeable (FR-7) — for up to a whole heal interval.
   *
   * Found by running the app rather than by a test, which is the point of
   * running it.
   *
   * This also establishes the opening sync state, and it is a reading rather
   * than a claim: FR-22 is specifically that the indicator must never say
   * synced when it is not.
   */
  await maybeCommit()

  /**
   * Announce the opening state, whatever it turned out to be.
   *
   * `setState` deliberately pushes only on a change, and a fresh vault starts
   * its local `state` at `up-to-date` — so opening a *clean* vault decided
   * nothing had changed and pushed nothing at all. That is fine for one vault
   * and wrong for two: the renderer holds a single sync state for the whole app,
   * so it went on displaying the vault it had just switched away from, and an
   * empty vault inherited a stale count from the one before it.
   *
   * Unconditional rather than routed through `setState`, because the value being
   * equal to the last one is exactly the case that needs sending: the renderer's
   * copy belongs to a different vault entirely.
   */
  if (!closed) args.onSyncState(state)

  // Drain anything a killed quit or a prior offline session left unpushed. The
  // opening `maybeCommit` above may also have just committed a dirty-on-open
  // tree; either way, get it to the remote. Fire-and-forget — an unreachable
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
      // ⌘S, a vault switch, and quit. Skips the timer entirely — FR-4 calls it
      // a real commit point rather than a placebo.
      if (commitTimer !== null) {
        clearTimeout(commitTimer)
        commitTimer = null
      }
      return maybeCommit()
    },
    pushNow,
    onFocus() {
      // A fetch is already running, so this focus needs neither a pull nor a
      // throttle window of its own. Stamping first and discovering the
      // in-flight guard afterwards bought 30 s of silence for a focus that did
      // nothing — and the alt-tab that then went unserved is the one the user
      // was waiting on.
      if (pullInFlight) return
      // FR-9. Throttled, or every alt-tab is a fetch.
      const now = Date.now()
      if (now - lastFocusPull < timings.focusThrottleMs) return
      lastFocusPull = now
      // Pull, then drain the backlog: coming back to the app is exactly when an
      // offline session's unpushed commits should leave. `pushNow` declines
      // while the pull is in flight, so it runs after — hence the chain.
      void maybePull().then(() => pushNow())
    },
    pause(reason) {
      manualPause = reason
      setState({ kind: 'paused', reason })
    },
    resume() {
      manualPause = null
      // The conflict pause has to go too, and this is the ONLY thing that
      // clears it. FR-12 makes it sticky on purpose — otherwise the loop
      // re-runs the same doomed merge every interval — but sticky with no way
      // out strands the vault: the banner stays up forever and no pull is ever
      // attempted again, even once the conflict has actually been resolved.
      // FR-18's "resumes normal operation" is this line.
      conflictPaths = null
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
        // computeState reports `merging`-paused on its own — nothing else to hold.
        conflictPaths = result.paths
        await refreshState()
        return { paths: result.paths }
      }
      // It merged clean (or was already up-to-date): clear the sticky banner and
      // return to normal — a merge commit, if any, still needs pushing.
      conflictPaths = null
      await rescan()
      schedulePush()
      await refreshState()
      return { paths: [] }
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

  /** The switch/quit push budget, shared with the vault's own timings so a test
   *  can shrink it. `pushNow` never rejects, so the race only guards latency. */
  const pushBudgetMs = args.timings?.pushBudgetMs ?? DEFAULT_TIMINGS.pushBudgetMs

  async function closeCurrent(): Promise<void> {
    if (current === null) return
    const vault = current
    current = null
    // FR-6: flush before letting go. Nothing is watching this tree once the
    // vault is closed, so a dirty file left here is one nobody will notice —
    // and a tree that is not clean is one the next pull cannot merge.
    await vault.commitNow().catch((err) => console.error('[vault] flush on switch failed:', err))
    // A vault switch is a leave point: get the just-committed work to the remote
    // before this vault stops running. Budgeted, because switching must not hang
    // on an unreachable remote — the work is committed on disk regardless, and
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
          // open is how the renderer asks for a fresh picture of it — after its
          // own reload, say — and returning without a word leaves it showing
          // whatever it last had, which may be another vault's state or the
          // `up-to-date` an empty atom starts life with.
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
          timings: args.timings,
        })
        return current
      }),

    close: () => serialise(closeCurrent),
  }
}
