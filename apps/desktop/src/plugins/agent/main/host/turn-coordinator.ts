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
 * A session leaves the set on `Stop`, on a confirmed registry `idle`, on exit,
 * or on its own safety cap. The cap is a backstop: escaping a permission prompt
 * fires no `Stop` hook at all.
 *
 * NOTE: no runtime `electron` import — this loads under vitest like the rest of
 * `agent/`.
 */
import type { PluginCtx } from '../../../../main/plugin-api'
import type { TurnLog, TurnRecord } from './turn-log'

/** What the coordinator needs of the vault its sessions run in. */
export type TurnVault = Pick<PluginCtx, 'root' | 'pauseSync' | 'commitNow' | 'head'>

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
  /** `Stop` for this session. */
  end(sessionId: string): void
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
  /** The sessions currently mid-turn. A snapshot; mutating it changes nothing. */
  readonly working: ReadonlySet<string>
}

/** One session's open turn. */
interface Turn {
  sessionId: string
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
  /** The vault's sync hold, taken by the first session in. */
  let release: (() => void) | null = null
  /** Record writes, one at a time: each append reads and rewrites the whole
   *  log, so two at once would lose one. */
  let writing: Promise<void> = Promise.resolve()

  function write(vault: TurnVault, records: TurnRecord[]): Promise<void> {
    const turnLog = deps.turnLogFor?.(vault.root)
    if (turnLog === undefined) return Promise.resolve()
    const next = writing.then(async () => {
      for (const record of records) await turnLog.append(record)
    })
    writing = next.catch(() => {})
    return next
  }

  /** A turn that ended while another is still running, recorded now against
   *  the working tree, or HEAD when the snapshot fails. Fire-and-forget like
   *  `settleBatch`. */
  async function recordNow(vault: TurnVault, turn: Turn): Promise<void> {
    if (deps.turnLogFor === undefined) return
    await turn.basePending
    if (turn.base === null) return
    const end = (await deps.snapshot?.(vault.root)) ?? (await vault.head())
    if (end === null) return
    await write(vault, [
      {
        base: turn.base,
        end,
        at: new Date().toISOString(),
        sessionId: turn.sessionId,
        overlapped: turn.overlapped,
      },
    ])
  }

  /**
   * Write the batch's records against one settle commit.
   *
   * Fire-and-forget at every call site, with rejections swallowed: this runs
   * under a hook request that must answer immediately with an empty body, and a
   * failed record must never disturb the sync resume it shares that body with.
   */
  async function settleBatch(vault: TurnVault, batch: Turn[]): Promise<void> {
    const turnLogFor = deps.turnLogFor
    if (turnLogFor === undefined) return
    await Promise.all(batch.map((turn) => turn.basePending))

    const recordable: Array<{ sessionId: string; base: string; overlapped: boolean }> = []
    for (const turn of batch) {
      if (turn.base === null) continue
      recordable.push({ sessionId: turn.sessionId, base: turn.base, overlapped: turn.overlapped })
    }
    if (recordable.length === 0) return

    // Taken explicitly rather than observed. Waiting for the idle committer to
    // fire on its own would make the end sha race a 3-second timer that the
    // safety-cap path does not respect; `commitNow` returns null on a clean
    // tree, which is the ordinary outcome of a turn that only read.
    //
    // Resuming the vault starts a commit of its own (its retry), which can be
    // the one holding the tree when this asks: `commitNow` then answers null
    // with the turn's work still landing. So a null is asked again once that
    // commit has had a moment, and only then read as "nothing to commit".
    let end = await vault.commitNow()
    if (end === null) {
      await new Promise((r) => setTimeout(r, deps.settleRetryMs ?? 1_000))
      end = (await vault.commitNow()) ?? (await vault.head())
    }
    if (end === null) return
    const at = new Date().toISOString()
    // One `end` for all of them: that sha IS what "they shared a settle commit"
    // means, and it is how the reviewer sees the same tree each of them landed in.
    await write(
      vault,
      recordable.map((turn) => ({
        base: turn.base,
        end,
        at,
        sessionId: turn.sessionId,
        overlapped: turn.overlapped,
      })),
    )
  }

  /** Leave the working set; `record` is false for a session that died. */
  function leave(sessionId: string, record: boolean): void {
    const turn = turns.get(sessionId)
    if (turn === undefined) return
    if (turn.safety !== null) clearTimeout(turn.safety)
    turns.delete(sessionId)

    // Another session still holds the pause. Its turn will do the resume (a
    // turn released by the safety cap must not resume the vault under a session
    // that is still working), and this one is recorded against the working tree
    // now, or, with no snapshot to take, waits for that settle commit.
    const vault = deps.vault()
    if (record && turns.size > 0 && deps.snapshot !== undefined) {
      if (vault !== null) {
        void recordNow(vault, turn).catch((err: unknown) =>
          log(`turn record failed: ${String(err)}`),
        )
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
        void settleBatch(vault, batch).catch((err: unknown) =>
          log(`turn record failed: ${String(err)}`),
        )
      }
    }
    deps.onChange?.()
    if (record) deps.onTurnEnd?.(sessionId)
  }

  return {
    begin(sessionId) {
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
        base: null,
        basePending: Promise.resolve(),
        overlapped: !wasEmpty,
        safety: null,
        idleSince: null,
      }
      // Captured BEFORE the pause: the base is the tree the turn started
      // against. Skipped with no log to record into.
      if (vault !== null && deps.turnLogFor !== undefined) {
        turn.basePending = vault
          .head()
          .then((sha) => {
            turn.base = sha
          })
          .catch(() => {})
      }
      turns.set(sessionId, turn)
      // The pause belongs to the vault, so only the first session in takes it.
      if (wasEmpty && vault !== null) release = vault.pauseSync('the assistant is working')
      turn.safety = setTimeout(() => {
        log(`session ${sessionId} released by the ${turnSafetyMs}ms safety cap`)
        leave(sessionId, true)
      }, turnSafetyMs)
      deps.onChange?.()
    },

    end(sessionId) {
      leave(sessionId, true)
    },

    noteBusy(sessionId) {
      const turn = turns.get(sessionId)
      if (turn !== undefined) turn.idleSince = null
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
