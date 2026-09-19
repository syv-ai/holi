/**
 * The vault's working set: which of its agent sessions are mid-turn, and what
 * that means for the one git actor they all share.
 *
 * A vault runs several `claude` sessions (D100) but has exactly one sync loop,
 * so the pause is the **vault's** while the turn bracket is each **session's**.
 * That mismatch is the whole of this module: the vault pauses once, when the
 * working set goes from empty to non-empty, and resumes once, when it empties.
 * Two sessions that each pause and resume for themselves would have the first
 * one to finish resume the loop under the other, and put Holi's committer back
 * on `.git/index.lock` beside a live agent — which is the contention the bracket
 * exists to prevent.
 *
 * Every turn that ended inside one pause therefore shares **one settle commit**,
 * and so shares its `end` sha. A turn whose span was open at the same instant as
 * another session's records `overlapped`, because its range then contains work
 * it did not do, and the reviewer deserves to be told rather than to infer it
 * from two identical shas.
 *
 * A session leaves the set on `Stop`, on a confirmed registry `idle`, on exit,
 * or on its own safety cap. The cap is a backstop rather than the mechanism:
 * escaping a permission prompt fires no `Stop` hook at all (measured over 166 s),
 * and before the registry existed that turn ran out the full ten minutes with
 * the vault paused behind it.
 *
 * NOTE: no runtime `electron` import — this loads under vitest like the rest of
 * `agent/`.
 */
import type { ActiveVault } from '../vault/active-vault'
import type { TurnLog } from './turn-log'

export interface TurnCoordinatorDeps {
  /** The vault these sessions run in, or null when none is open. Read per call
   *  rather than held: the active vault moves under this coordinator. */
  activeVault(): ActiveVault | null
  /** Records what a turn changed, as a commit range (D88). Keyed by vault ROOT.
   *  Absent means no recording rather than a broken one. */
  turnLogFor?: (vaultRoot: string) => TurnLog
  /** Force-release a session whose turn never ends. Default 600000 (10 min). */
  turnSafetyMs?: number
  /** How long a session must have read `idle` before that counts as its turn
   *  ending. Default 1000. */
  idleConfirmMs?: number
  now?: () => number
  /** The working set changed, so whatever renders session state should re-derive
   *  it. Called once per membership change. */
  onChange?: () => void
  log?: (msg: string) => void
}

export interface TurnCoordinator {
  /** `UserPromptSubmit` for this session. */
  begin(sessionId: string): void
  /** `Stop` for this session. */
  end(sessionId: string): void
  /**
   * Claude Code's own session listing reports this session `idle`.
   *
   * Confirmed, not acted on at once: the listing reports `busy` throughout tool
   * execution and `waiting` during a prompt, so `idle` really does mean no turn
   * — but a single reading is one flap away from resuming the vault mid-turn,
   * and a second reading a second later costs nothing. The caller is expected to
   * take that second reading rather than wait for a watcher edge that a quiet
   * session will never produce.
   */
  noteIdle(sessionId: string): void
  /** The session died. It leaves the set at once, and records nothing: a turn
   *  killed part-way has no end of its own, and the teardown path has always
   *  resumed the vault without writing one. */
  forget(sessionId: string): void
  /** The sessions currently mid-turn. A snapshot; mutating it changes nothing. */
  readonly working: ReadonlySet<string>
}

/** One session's open turn. */
interface Turn {
  sessionId: string
  /** The vault it began in, or null if none was open. A record is written only
   *  while that is still the vault on screen: attributing a turn to whichever
   *  vault is open now is the mistake D87 caught in D86's migration. */
  remote: string | null
  base: string | null
  /** `head()` is async and `begin` is not, so the end of the turn waits on the
   *  start of it rather than racing it. */
  basePending: Promise<void>
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
  const now = deps.now ?? (() => Date.now())

  /** Sessions mid-turn. Empty means the vault is free to sync. */
  const turns = new Map<string, Turn>()
  /** Turns that have ended while others were still running, held until the set
   *  empties so they share the one settle commit. */
  let settling: Turn[] = []

  /**
   * Write the batch's records against one settle commit.
   *
   * Fire-and-forget at every call site, with rejections swallowed: this runs
   * under a hook request that must answer immediately with an empty body, and a
   * failed record must never disturb the sync resume it shares that body with.
   */
  async function settleBatch(batch: Turn[]): Promise<void> {
    const turnLogFor = deps.turnLogFor
    if (turnLogFor === undefined) return
    await Promise.all(batch.map((turn) => turn.basePending))
    const vault = deps.activeVault()
    if (vault === null) return

    const recordable: Array<{ sessionId: string; base: string; overlapped: boolean }> = []
    for (const turn of batch) {
      if (turn.remote !== vault.remote || turn.base === null) continue
      recordable.push({ sessionId: turn.sessionId, base: turn.base, overlapped: turn.overlapped })
    }
    if (recordable.length === 0) return

    // Taken explicitly rather than observed. Waiting for the idle committer to
    // fire on its own would make the end sha race a 3-second timer that the
    // safety-cap path does not respect; `commitNow` returns null on a clean
    // tree, which is the ordinary outcome of a turn that only read.
    const end = (await vault.commitNow()) ?? (await vault.repo.head())
    if (end === null) return
    const at = new Date().toISOString()
    const turnLog = turnLogFor(vault.root)
    // One `end` for all of them: that sha IS what "they shared a settle commit"
    // means, and it is how the reviewer sees the same tree each of them landed in.
    for (const turn of recordable) {
      await turnLog.append({
        base: turn.base,
        end,
        at,
        sessionId: turn.sessionId,
        overlapped: turn.overlapped,
      })
    }
  }

  /** Leave the working set; `record` is false for a session that died. */
  function leave(sessionId: string, record: boolean): void {
    const turn = turns.get(sessionId)
    if (turn === undefined) return
    if (turn.safety !== null) clearTimeout(turn.safety)
    turns.delete(sessionId)
    if (record) settling.push(turn)

    // Another session still holds the pause. Its turn will do the resume, and
    // this one's record waits for it — a turn released by the safety cap must
    // not resume the vault under a session that is still working.
    if (turns.size === 0) {
      // Resume BEFORE the settle commit: `commitAll` refuses to run while the
      // vault reads as paused, and a turn that never resumed the vault is the
      // failure the safety cap exists to prevent.
      deps.activeVault()?.resume()
      const batch = settling
      settling = []
      if (batch.length > 0) {
        void settleBatch(batch).catch((err: unknown) => log(`turn record failed: ${String(err)}`))
      }
    }
    deps.onChange?.()
  }

  return {
    begin(sessionId) {
      // A second `UserPromptSubmit` without a `Stop` between them is the same
      // turn continuing, not a new one: it must not re-capture the base or push
      // the safety cap out.
      if (turns.has(sessionId)) return
      const vault = deps.activeVault()
      const wasEmpty = turns.size === 0
      // Two spans open at the same instant crossed each other, both ways. Marked
      // as the second one starts, because by the time either ends the other may
      // already be gone from the set.
      if (!wasEmpty) for (const open of turns.values()) open.overlapped = true

      const turn: Turn = {
        sessionId,
        remote: vault?.remote ?? null,
        base: null,
        basePending: Promise.resolve(),
        overlapped: !wasEmpty,
        safety: null,
        idleSince: null,
      }
      // Captured BEFORE the pause. It is the same sha either way today; the
      // ordering states the intent, which is that the base is the tree the turn
      // started against rather than the tree it was allowed to touch.
      if (vault !== null) {
        turn.basePending = vault.repo
          .head()
          .then((sha) => {
            turn.base = sha
          })
          .catch(() => {})
      }
      turns.set(sessionId, turn)
      // The pause belongs to the vault, so only the first session in takes it.
      if (wasEmpty) vault?.pause('the assistant is working')
      turn.safety = setTimeout(() => {
        log(`session ${sessionId} released by the ${turnSafetyMs}ms safety cap`)
        leave(sessionId, true)
      }, turnSafetyMs)
      deps.onChange?.()
    },

    end(sessionId) {
      leave(sessionId, true)
    },

    noteIdle(sessionId) {
      const turn = turns.get(sessionId)
      if (turn === undefined) return // not mid-turn: idle is its ordinary state
      const at = now()
      if (turn.idleSince === null) {
        turn.idleSince = at
        return
      }
      if (at - turn.idleSince < idleConfirmMs) return
      log(`session ${sessionId} released by a confirmed idle`)
      leave(sessionId, true)
    },

    forget(sessionId) {
      leave(sessionId, false)
    },

    get working() {
      return new Set(turns.keys())
    },
  }
}
