/**
 * The vault's working set: which of its agent sessions are mid-turn, and what
 * that means for the one git actor they all share.
 *
 * A vault runs several `claude` sessions but has exactly one sync loop,
 * so the pause is the **vault's** while the turn bracket is each **session's**.
 * The vault pauses once, when the working set goes from empty to non-empty, and
 * resumes once, when it empties. Per-session pause/resume would let the first
 * session to finish resume the loop under the other, putting Holi's committer
 * back on `.git/index.lock` beside a live agent.
 *
 * The last session out takes **one settle commit**, and every turn still
 * waiting on it ends there. A session that ends while another is still working
 * cannot wait for that: its next prompt asks what changed since its turn ended,
 * and until its record exists the answer is its own edits. With a `snapshot` it
 * is recorded at once, ending at the working tree as it stood
 * (`worktree-end.ts`). A turn whose span overlapped another session's records
 * `overlapped`, because its range then contains work it did not do.
 *
 * `end` answers with the settle commit when that `Stop` emptied the set and
 * the commit landed: the Stop hook saves its tree as where the turn left the
 * vault, so the next prompt does not name what the commit's transforms
 * rewrote (docs/features/agent-config.md).
 *
 * A session leaves the set on `Stop`, on a confirmed registry `idle`, on exit,
 * or on its own safety cap. The cap is a backstop: escaping a permission prompt
 * fires no `Stop` hook at all. A managed turn or a PTY turn being drained
 * leaves only on its owner's proof.
 *
 * NOTE: no runtime `electron` import — this loads under vitest like the rest of
 * `agent/`.
 */
import type { PluginCtx } from '../../../../main/plugin-api'
import type { TurnLog, TurnRecord } from './turn-log'

/** What the coordinator needs of the vault its sessions run in. */
export type TurnVault = Pick<PluginCtx, 'root' | 'pauseSync' | 'commitNow' | 'head'> &
  Partial<Pick<PluginCtx, 'captureFinalization'>> & {
    claimManagedTurn?(id: string, turn: ManagedTurn): boolean
  }

export interface ManagedTurn {
  /** After the owner proves the turn is no longer writing: resolves only
   *  after its record was written. The owner's deadline can revoke a queued
   *  write or its publication, but cannot undo an append already in flight. */
  end(signal?: AbortSignal): Promise<TurnRecord>
  /** After physical proof without a usable end: release without recording. */
  forget(): void
}

/** Join the session host's existing bracket and working set. Claim is only
 *  open for the synchronous begin edge, on this vault activation. */
export function createManagedTurnBrackets() {
  let opening: { id: string; turn?: ManagedTurn } | undefined
  return {
    claimManagedTurn(id: string, turn: ManagedTurn): boolean {
      if (opening?.id !== id || opening.turn !== undefined) return false
      opening.turn = turn
      return true
    },
    begin(id: string, bracket: (id: string, edge: 'begin' | 'forget') => void): ManagedTurn {
      const request: NonNullable<typeof opening> = { id }
      const parent = opening
      opening = request
      try {
        bracket(id, 'begin')
      } finally {
        opening = parent
      }
      const turn = request.turn
      if (turn === undefined) throw new Error(`Could not open the managed turn for ${id}.`)
      let registered = true
      const unregister = () => {
        if (!registered) return
        registered = false
        // Drop the listing's external-driver marker; only the handle below
        // can release the managed turn itself.
        bracket(id, 'forget')
      }
      return {
        end: (signal) => {
          unregister()
          return turn.end(signal)
        },
        forget: () => {
          unregister()
          turn.forget()
        },
      }
    },
  }
}

export interface TurnCoordinatorDeps {
  /** The vault these sessions run in, or null when none is attached. Read per
   *  call rather than held: the agent attaches to each vault as it opens. */
  vault(): TurnVault | null
  /** Records what a turn changed, as a commit range. Keyed by vault ROOT.
   *  Absent means no recording rather than a broken one. */
  turnLogFor?: (vaultRoot: string) => TurnLog
  /** How long to wait before asking again for a settle commit that answered
   *  null. Default 1000. */
  settleRetryMs?: number
  /** Maximum time a drain waits for admitted turn persistence. */
  drainCapMs?: number
  /** Where a turn that ends while another session's is still running ended: a
   *  sha `git diff` can take, or null when git fails. Absent, such a turn waits
   *  for the settle commit like the rest. */
  snapshot?: (vaultRoot: string) => Promise<string | null>
  /** Force-release a session whose turn never ends. Default 600000 (10 min). */
  turnSafetyMs?: number
  /** How long a session must have read `idle` before that counts as its turn
   *  ending. Default 1000. */
  idleConfirmMs?: number
  now?: () => number
  /** The working set changed, so whatever renders session state should re-derive
   *  it. Called once per membership change. */
  onChange?: () => void
  /** A session's turn ended: `Stop`, a confirmed idle, or the safety cap. Not
   *  for a session that died, whose turn has no end of its own. */
  onTurnEnd?: (sessionId: string) => void
  log?: (msg: string) => void
}

export interface TurnCoordinator {
  /** `UserPromptSubmit` for this session. */
  begin(sessionId: string): void
  /** `Stop` for this session. Answers the settle commit's sha once it has
   *  landed, when this ended the last turn out; null when no commit landed,
   *  another session is still working, or the session was not mid-turn. */
  end(sessionId: string): Promise<string | null>
  /**
   * Claude Code's own session listing reports this session `idle`.
   *
   * Confirmed, not acted on at once: a single reading is one flap away from
   * resuming the vault mid-turn. The caller takes the second reading itself,
   * because a quiet session produces no watcher edge.
   */
  noteIdle(sessionId: string): void
  /**
   * The listing reports this session as anything but `idle`.
   *
   * This is what makes the confirmation two **consecutive** readings: without
   * it, one spurious `idle` would sit as half a pair for the rest of the turn.
   */
  noteBusy(sessionId: string): void
  /** The session died. It leaves the set at once and records nothing: a turn
   *  killed part-way has no end of its own. */
  forget(sessionId: string): void
  /** Protect only the open PTY turn. The returned handle requires physical proof. */
  protectPtyTurn(sessionId: string): (() => void) | undefined
  /** Wait for turn records and settle commits already entered by this vault. */
  drain(): Promise<void>
  /** The sessions currently mid-turn. A snapshot; mutating it changes nothing. */
  readonly working: ReadonlySet<string>
}

/** One session's open turn. */
interface Turn {
  sessionId: string
  /** Vault admitted with this turn; never resolve ownership at settlement time. */
  vault: TurnVault | null
  base: string | null
  finalize: ReturnType<PluginCtx['captureFinalization']>
  /** `head()` is async and `begin` is not, so the end of the turn waits on the
   *  start of it rather than racing it. */
  basePending: Promise<void>
  managed: boolean
  ptyDraining?: true
  history?: {
    signal?: AbortSignal
    resolve(record: TurnRecord): void
    reject(error: unknown): void
  }
  overlapped: boolean
  safety: ReturnType<typeof setTimeout> | null
  /** When the listing first read this session `idle`, for the confirmation.
   *  Null until then, and null again for every new turn. */
  idleSince: number | null
}

export function createTurnCoordinator(deps: TurnCoordinatorDeps): TurnCoordinator {
  const log = deps.log ?? ((msg: string) => console.log(`[turn] ${msg}`))
  const turnSafetyMs = deps.turnSafetyMs ?? 600_000
  const idleConfirmMs = deps.idleConfirmMs ?? 1_000
  const drainCapMs = deps.drainCapMs ?? 5_000
  const now = deps.now ?? (() => Date.now())

  /** Sessions mid-turn. Empty means the vault is free to sync. */
  const turns = new Map<string, Turn>()
  /** Turns that have ended while others were still running, held until the set
   *  empties so they share the one settle commit. */
  let settling: Turn[] = []
  /** The vault's sync hold, taken by the first session in. */
  let release: (() => void) | null = null
  /** Record writes, one at a time: each append reads and rewrites the whole
   *  log, so two at once would lose one. */
  let writing: Promise<void> = Promise.resolve()
  const pending = new Set<Promise<unknown>>()
  const finalizationFailures = new Set<unknown>()
  let closed = false
  function track<T>(promise: Promise<T>): Promise<T> {
    pending.add(promise)
    void promise.then(
      () => pending.delete(promise),
      (err: unknown) => {
        finalizationFailures.add(err)
        pending.delete(promise)
      },
    )
    return promise
  }

  async function writeRecord(
    vault: TurnVault,
    turn: Turn,
    end: string | null,
    at: string,
  ): Promise<TurnRecord | null> {
    if (turn.base === null || end === null || deps.turnLogFor === undefined) return null
    const record: TurnRecord = {
      base: turn.base,
      end,
      at,
      sessionId: turn.sessionId,
      overlapped: turn.overlapped,
    }
    const turnLog = deps.turnLogFor(vault.root)
    const next = writing.then(() => {
      turn.history?.signal?.throwIfAborted()
      return turnLog.append(record)
    })
    writing = next.catch(() => {}) // keep serializing after a failed append
    await next
    return record
  }

  async function persist(turn: Turn, work: () => Promise<TurnRecord | null>): Promise<void> {
    try {
      const record = await work()
      if (turn.history !== undefined) {
        turn.history.signal?.throwIfAborted()
        if (record === null) throw new Error(`No turn history was written for ${turn.sessionId}.`)
        turn.history.resolve(record)
      }
    } catch (err) {
      turn.history?.reject(err)
      log(`turn record failed: ${String(err)}`)
      throw err
    }
  }

  /** A turn that ended while another is still running is recorded now against
   *  the working tree, or HEAD when the snapshot fails. */
  async function recordNow(vault: TurnVault, turn: Turn): Promise<TurnRecord | null> {
    await turn.basePending
    if (deps.turnLogFor === undefined || turn.base === null) return null
    const end = (await deps.snapshot?.(vault.root)) ?? (await turn.finalize(() => vault.head()))
    return writeRecord(vault, turn, end, new Date().toISOString())
  }

  /**
   * Take the settle commit and write the batch's records against it. Answers
   * the commit when one landed.
   *
   * Never awaited by the sync resume: a failed record must not disturb the
   * resume, but the coordinator retains it for its drain.
   */
  async function settleBatch(vault: TurnVault, batch: Turn[]): Promise<string | null> {
    const range = settleRange(vault, batch)
    // Each receipt follows its own append, not the whole batch. A failed
    // append cannot report success for that turn or skip another turn's write.
    const results = await Promise.allSettled(
      batch.map((turn) =>
        track(
          persist(turn, async () => {
            await turn.basePending
            if (turn.base === null) return null
            const { end, at } = await range
            return writeRecord(vault, turn, end, at)
          }),
        ),
      ),
    )
    const { commit } = await range
    return results.some((result) => result.status === 'rejected') ? null : commit
  }

  async function settleRange(vault: TurnVault, batch: Turn[]) {
    await Promise.allSettled(batch.map((turn) => turn.basePending))
    if (deps.turnLogFor === undefined || !batch.some((turn) => turn.base !== null))
      return { commit: null, end: null, at: new Date().toISOString() }

    // Taken explicitly rather than observed. Waiting for the idle committer to
    // fire on its own would make the end sha race a 3-second timer that the
    // safety-cap path does not respect; `commitNow` returns null on a clean
    // tree, which is the ordinary outcome of a turn that only read.
    //
    // Resuming the vault starts a commit and then a pull of its own (its
    // retry). `commitNow` waits that commit out, but declines while the pull
    // runs, answering `'busy'` with the turn's work still uncommitted. So that
    // is asked again once the pull has had a moment; a null (a clean tree) is
    // not, so the Stop hook waiting on a turn that only read is not held.
    const { commit, end } = await batch[0]!.finalize(async () => {
      let asked = await vault.commitNow()
      if (asked === 'busy') {
        await new Promise((r) => setTimeout(r, deps.settleRetryMs ?? 1_000))
        asked = await vault.commitNow()
      }
      const commit = asked === 'busy' ? null : asked
      return { commit, end: commit ?? (await vault.head()) }
    })
    return { commit, end, at: new Date().toISOString() }
  }

  /** Leave the working set; `record` is false for a session that died.
   *  Answers the settle commit this took, when it took one and it landed. */
  function leave(sessionId: string, record: boolean): Promise<string | null> {
    let settled: Promise<string | null> = Promise.resolve(null)
    const turn = turns.get(sessionId)
    if (turn === undefined) return settled
    if (turn.safety !== null) clearTimeout(turn.safety)
    turns.delete(sessionId)

    // Another session still holds the pause. Its turn will do the resume (a
    // turn released by the safety cap must not resume the vault under a session
    // that is still working), and this one is recorded against the working tree
    // now, or, with no snapshot to take, waits for that settle commit.
    const vault = turn.vault
    if (record && turns.size > 0 && deps.snapshot !== undefined) {
      if (vault !== null) {
        void track(persist(turn, () => recordNow(vault, turn))).catch(() => {})
      }
    } else if (record) {
      settling.push(turn)
    }

    if (turns.size === 0) {
      // Resume BEFORE the settle commit: `commitAll` refuses to run while the
      // vault reads as paused, and a turn that never resumed the vault is the
      // failure the safety cap exists to prevent.
      release?.()
      release = null
      const batch = settling
      settling = []
      // The vault the turns ran in, held: a commit in a vault left meanwhile
      // throws rather than landing in the next one.
      if (batch.length > 0 && vault !== null) {
        settled = track(settleBatch(vault, batch)).catch(() => null)
      }
    }
    deps.onChange?.()
    if (record && !turn.managed) deps.onTurnEnd?.(sessionId)
    return settled
  }

  function managedTurn(turn: Turn): ManagedTurn {
    const { sessionId } = turn
    let ending: Promise<TurnRecord> | undefined
    return {
      end(signal) {
        if (ending !== undefined) return ending
        if (turns.get(sessionId) !== turn)
          return Promise.reject(new Error(`The managed turn for ${sessionId} is no longer open.`))
        const persisted = new Promise<TurnRecord>((resolve, reject) => {
          turn.history = { signal, resolve, reject }
        })
        ending = track(
          persisted.then((record) => {
            signal?.throwIfAborted()
            deps.onTurnEnd?.(sessionId)
            return record
          }),
        )
        try {
          void leave(sessionId, true)
        } catch (error) {
          turn.history?.reject(error)
        }
        return ending
      },
      forget() {
        if (turns.get(sessionId) === turn) void leave(sessionId, false)
      },
    }
  }

  return {
    begin(sessionId) {
      // Teardown closes admission synchronously; already-open turns may still
      // finish and settle against the vault they captured at begin.
      if (closed) return
      // A second `UserPromptSubmit` without a `Stop` between them is the same
      // turn continuing, not a new one: it must not re-capture the base or push
      // the safety cap out.
      if (turns.has(sessionId)) return
      const vault = deps.vault()
      const wasEmpty = turns.size === 0
      // Two spans open at the same instant crossed each other, both ways. Marked
      // as the second one starts, because by the time either ends the other may
      // already be gone from the set.
      if (!wasEmpty) for (const open of turns.values()) open.overlapped = true

      const turn: Turn = {
        sessionId,
        vault,
        base: null,
        finalize:
          typeof vault?.captureFinalization === 'function'
            ? vault.captureFinalization()
            : async (work) => work(),
        basePending: Promise.resolve(),
        managed: false,
        overlapped: !wasEmpty,
        safety: null,
        idleSince: null,
      }
      // Captured BEFORE the pause: the base is the tree the turn started
      // against. A hook admitted before stop may still be waiting for this read
      // after its activation is revoked, so use the same narrow authority as
      // settle finalization. Skipped with no log to record into.
      if (vault !== null && deps.turnLogFor !== undefined) {
        turn.basePending = track(
          turn
            .finalize(() => vault.head())
            .then((sha) => {
              turn.base = sha
            }),
        )
      }
      // Only the first session takes the vault's hold. Protect it on POSIX
      // even if that session is unmanaged: a managed writer can join later.
      // If teardown cannot prove that writer is gone, core must not resume.
      if (wasEmpty && vault !== null)
        release = vault.pauseSync('the assistant is working', {
          retainOnFailure: process.platform !== 'win32',
        })
      turns.set(sessionId, turn)
      turn.managed = vault?.claimManagedTurn?.(sessionId, managedTurn(turn)) ?? false
      // A cap or listing sample is not proof that a managed writer is gone.
      if (!turn.managed) {
        turn.safety = setTimeout(() => {
          log(`session ${sessionId} released by the ${turnSafetyMs}ms safety cap`)
          void leave(sessionId, true)
        }, turnSafetyMs)
      }
      deps.onChange?.()
    },

    end(sessionId) {
      const turn = turns.get(sessionId)
      return turn?.managed || turn?.ptyDraining ? Promise.resolve(null) : leave(sessionId, true)
    },

    noteBusy(sessionId) {
      const turn = turns.get(sessionId)
      if (turn !== undefined) turn.idleSince = null
    },

    noteIdle(sessionId) {
      const turn = turns.get(sessionId)
      if (turn === undefined || turn.managed || turn.ptyDraining) return
      const at = now()
      if (turn.idleSince === null) {
        turn.idleSince = at
        return
      }
      if (at - turn.idleSince < idleConfirmMs) return
      log(`session ${sessionId} released by a confirmed idle`)
      void leave(sessionId, true)
    },

    forget(sessionId) {
      // Session-host teardown cannot discard a writer that now requires proof.
      const turn = turns.get(sessionId)
      if (!turn?.managed && !turn?.ptyDraining) void leave(sessionId, false)
    },

    protectPtyTurn(sessionId) {
      const turn = turns.get(sessionId)
      if (!turn || turn.managed || turn.ptyDraining) return
      turn.ptyDraining = true
      if (turn.safety !== null) clearTimeout(turn.safety)
      turn.safety = null
      return () => {
        if (turns.get(sessionId) === turn) void leave(sessionId, false)
      }
    },

    async drain() {
      closed = true
      let timer: ReturnType<typeof setTimeout> | undefined
      const bounded = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Agent turn history did not drain before teardown timed out.')),
          drainCapMs,
        )
      })
      try {
        await Promise.race([
          (async () => {
            while (pending.size > 0) await Promise.allSettled([...pending])
            await writing
          })(),
          bounded,
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      if (finalizationFailures.size > 0)
        throw new AggregateError(
          [...finalizationFailures],
          'Could not finalize agent turn history.',
        )
    },

    get working() {
      return new Set(turns.keys())
    },
  }
}
