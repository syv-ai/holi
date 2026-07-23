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
import { isIndexLockError, openRepo } from '../git'
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
     */
    if (pullInFlight && !duringPull) return null
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
      if (result.kind === 'merged') await rescan()
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

  /** Wait for an in-flight pull to finish. Polled rather than promise-chained:
   *  there is exactly one pull at a time, and a chain would have to be threaded
   *  through every early return in `maybePull`. */
  async function waitForIdlePull(): Promise<void> {
    for (let i = 0; pullInFlight && i < 600; i++) await new Promise((r) => setTimeout(r, 50))
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
   * empty vault inherited "31 to publish" from the one before it.
   *
   * Unconditional rather than routed through `setState`, because the value being
   * equal to the last one is exactly the case that needs sending: the renderer's
   * copy belongs to a different vault entirely.
   */
  if (!closed) args.onSyncState(state)

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
      //
      // It claims the same in-flight guard `maybePull` does, and must: a
      // publish pulls, so without this an interval tick and a Publish click can
      // have two `git merge`s running on one repo at once. They then fight over
      // MERGE_HEAD — one abort tears down the other's merge, and the loser
      // reports "There is no merge to abort" for a merge it was in the middle
      // of. Rare in production at a three-minute interval, and unpleasant.
      if (pullInFlight) {
        // A pull is already merging; let it finish rather than racing it.
        await waitForIdlePull()
      }
      pullInFlight = true
      syncing = 'publishing'
      await refreshState()
      try {
        /**
         * Publish is a commit point, like ⌘S (FR-4).
         *
         * The commit debounce restarts on every keystroke, so the tree is dirty
         * for as long as someone keeps typing — and a publish that only pushes
         * *commits* therefore pushes everything except the sentence they were
         * in the middle of. "Publish" has to mean "publish my work".
         *
         * `duringPull` is the sequenced-not-concurrent escape: `pullInFlight` is
         * already claimed above, and this commit runs before the merge rather
         * than alongside it.
         */
        await maybeCommit(true)
        const result = await args.repo.publish()
        offline = false
        // FR-15: a conflicting pre-publish pull hands off to the reconcile path
        // with nothing pushed and the user's work local and intact.
        //
        // Except when it names nothing — see `maybePull`, which has refused to
        // latch that since plan 4 and for the same reason. A merge refused
        // before it starts (the tree went dirty under it, or a git the user ran
        // took the index) reports no unmerged paths, and latching FR-12's
        // sticky pause on it disables auto-pull permanently for a conflict that
        // does not exist and no reconcile can clear. The result still goes back
        // to the caller: the publish genuinely did not happen.
        if (result.kind === 'conflict' && result.paths.length > 0) conflictPaths = result.paths
        return result
      } finally {
        syncing = null
        pullInFlight = false
        await refreshState()
      }
    },
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
      void maybePull()
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
