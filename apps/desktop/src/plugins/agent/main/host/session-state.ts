/**
 * What a vault's agent sessions are doing now.
 *
 * Three things say, and none is enough alone. Claude Code's **listing**
 * (`claude agents --json`) is the truth about what exists and what each
 * session reads as, but it is slow, can fail, and a quiet session makes no
 * watcher edge. The **turn hooks** say a turn began or ended the moment it
 * does, and are the floor under a listing that is slow or too old. The
 * **status line** carries the one thing neither does: how much context a
 * session has used. This module takes all three and answers the sessions and
 * the history, so nothing outside it knows how they combine.
 *
 * - **A read that failed is not an empty listing.** No output, a timeout, or
 *   output that is not a listing says nothing about the sessions, so the last
 *   listing stands. Taken for an empty one it would forget every working
 *   session and release the vault's sync hold mid-turn. Only a listing that
 *   was read and no longer has a session lets it go.
 * - **The first good read seeds the working set.** Sessions keep running
 *   while Holi is closed, so that read may find one mid-turn: its turn holds
 *   sync too. A first read that failed seeds nothing.
 * - **A turn ends on two consecutive idle readings.** One is a flap away from
 *   resuming the vault mid-turn, and a quiet session makes no edge to take the
 *   second, so this module takes it, a moment later, on its own timer.
 *
 * The vault's sync hold and the settle commit are the turn coordinator's
 * (`turn-coordinator.ts`), which this module drives and nothing else sees.
 *
 * No Electron import: this loads under plain Node like the rest of the plugin.
 */
import type { ClaudeRow, PastSession, SessionSummary } from '../claude/listing'
import type { AgentProvider } from '../provider'
import { createTurnCoordinator, type TurnVault } from './turn-coordinator'
import type { TurnLog } from './turn-log'

/** How long after an `idle` reading to take the second one that confirms it. */
const IDLE_RECHECK_MS = 1_100

/** Where a listing is read from: one vault's `claude agents --json`. The same
 *  object for as long as the vault is the one being read, so a read that
 *  lands after the vault moved is known by it. */
export interface ListingSource {
  /** The vault clone: only the rows under it are this vault's. */
  root: string
  /** What the command printed, or null when it did not (a missing binary, a
   *  non-zero exit, a timeout). */
  read(): Promise<string | null>
}

export interface SessionStateDeps {
  /** The listing to read, or null while no vault is attached. Read per call:
   *  the agent attaches to each vault as it opens. */
  source(): ListingSource | null
  /** The vault the turns run in, for the coordinator. */
  vault(): TurnVault | null
  provider: Pick<
    AgentProvider,
    'parseListing' | 'isLive' | 'summarise' | 'summarisePast' | 'readContextPercent'
  >
  /** The sessions or the history may have changed: tell whoever shows them. */
  onChange(): void
  turnLogFor?: (vaultRoot: string) => TurnLog
  turnSafetyMs?: number
  /** Forwarded to the turn coordinator. */
  idleConfirmMs?: number
  idleRecheckMs?: number
  log?: (msg: string) => void
}

export interface SessionState {
  /** Read the listing now. Serialised, and a read that lands after a newer one
   *  does not win. Never rejects. */
  refresh(): Promise<void>
  /** The live sessions, in listing order. */
  sessions(): SessionSummary[]
  /** The finished sessions, in listing order. */
  history(): PastSession[]
  /** The job ids of the live sessions. */
  liveIds(): string[]
  /** Whether the session is live. */
  isLive(id: string): boolean
  /** The session's listing row, live or past. */
  row(id: string): ClaudeRow | undefined
  /** The name the session is shown under, or undefined for one not listed. */
  nameOf(id: string): string | undefined
  /** A turn edge from the hook: begun, or ended with how much the Stop said
   *  was still pending. */
  noteTurn(jobId: string, active: boolean, pending?: number | null): void
  /** A session's status line fired: Claude Code's status JSON. */
  noteStatus(jobId: string, status: unknown): void
  /** Holi started the session with no prompt: it has had no turn yet, and
   *  leaving the vault removes it rather than leave a blank row to resume. A
   *  turn, or a message said to it, ends that. Holi's own record, not a
   *  reading of the listing, which cannot say whether a session ever had a
   *  turn. */
  startedEmpty(jobId: string): void
  spoke(jobId: string): void
  hasHadNoTurn(jobId: string): boolean
  /** Hear each session's turn end, by job id, with how much its Stop said was
   *  still pending (null when no Stop said: a confirmed idle, the safety cap,
   *  an older hook script). Returns the undo. */
  onTurnEnd(listener: (id: string, pending: number | null) => void): () => void
  /** Let go of the vault: no session is working, the listing is forgotten. */
  reset(): void
}

export function createSessionState(deps: SessionStateDeps): SessionState {
  const log = deps.log ?? ((msg: string) => console.log(`[agent] ${msg}`))
  const provider = deps.provider

  /** The latest good listing, live or not. */
  let rows: ClaudeRow[] = []
  /** The source whose first good read has seeded the working set. */
  let seededFor: ListingSource | null = null
  let idleRecheck: ReturnType<typeof setTimeout> | null = null
  const unprompted = new Set<string>()
  /**
   * Each live session's context use, by job id, from its status line. Claude
   * Code's listing does not carry it. The status line runs on Claude Code's
   * own events, a background session with no client attached included, and a
   * session between turns is not using any more.
   */
  const contextPercent = new Map<string, number>()
  const turnEnds = new Set<(id: string, pending: number | null) => void>()
  /** What the Stop that is ending a turn said was pending, until the end is
   *  told. */
  const stopPending = new Map<string, number>()

  const coordinator = createTurnCoordinator({
    vault: deps.vault,
    ...(deps.turnLogFor === undefined ? {} : { turnLogFor: deps.turnLogFor }),
    ...(deps.turnSafetyMs === undefined ? {} : { turnSafetyMs: deps.turnSafetyMs }),
    ...(deps.idleConfirmMs === undefined ? {} : { idleConfirmMs: deps.idleConfirmMs }),
    onChange: () => deps.onChange(),
    onTurnEnd: (id) => {
      const pending = stopPending.get(id) ?? null
      stopPending.delete(id)
      for (const listener of turnEnds) listener(id, pending)
    },
    log,
  })

  const live = (): ClaudeRow[] => rows.filter((row) => provider.isLive(row))

  /** Serialised: a read that lands after a newer one must not win. */
  let reading: Promise<void> | null = null
  let readAgain = false

  async function readOnce(): Promise<void> {
    const source = deps.source()
    if (source === null) return
    const stdout = await source.read()
    if (deps.source() !== source) return // the vault moved while we read
    const read = provider.parseListing(stdout, source.root)
    if (read === null) {
      log('listing failed; keeping the last one')
      return
    }
    rows = read
    const liveRows = live()
    const liveIds = new Set(liveRows.map((r) => r.id))

    if (seededFor !== source) {
      seededFor = source
      for (const row of liveRows) {
        if (row.status === 'busy' || row.status === 'shell') coordinator.begin(row.id)
      }
    }

    // A session whose process has gone will not end its turn now.
    for (const id of coordinator.working) if (!liveIds.has(id)) coordinator.forget(id)
    // Nor use any more context; resumed, it says so again at its first event.
    for (const id of contextPercent.keys()) if (!liveIds.has(id)) contextPercent.delete(id)

    let wantsRecheck = false
    for (const row of liveRows) {
      // Busy, or waiting on an answer, means a turn: the hook's floor.
      if (row.status !== undefined && row.status !== 'idle') unprompted.delete(row.id)
      if (row.status !== 'idle') {
        // Whatever it is doing, it is not between turns. That cancels any idle
        // candidacy, which makes the confirmation two CONSECUTIVE readings.
        coordinator.noteBusy(row.id)
        continue
      }
      if (!coordinator.working.has(row.id)) continue
      coordinator.noteIdle(row.id)
      if (coordinator.working.has(row.id)) wantsRecheck = true
    }
    if (wantsRecheck && idleRecheck === null) {
      idleRecheck = setTimeout(() => {
        idleRecheck = null
        void refresh()
      }, deps.idleRecheckMs ?? IDLE_RECHECK_MS)
    }
    deps.onChange()
  }

  async function refresh(): Promise<void> {
    if (reading !== null) {
      readAgain = true
      return reading
    }
    reading = (async () => {
      do {
        readAgain = false
        await readOnce().catch((err: unknown) => log(`refresh failed: ${String(err)}`))
      } while (readAgain)
    })()
    try {
      await reading
    } finally {
      reading = null
    }
  }

  return {
    refresh,
    sessions: () =>
      live().map((row) => provider.summarise(row, coordinator.working, contextPercent.get(row.id))),
    history: () =>
      rows.filter((row) => !provider.isLive(row)).map((row) => provider.summarisePast(row)),
    liveIds: () => live().map((row) => row.id),
    isLive: (id) => live().some((row) => row.id === id),
    row: (id) => rows.find((row) => row.id === id),
    nameOf(id) {
      const row = rows.find((r) => r.id === id)
      return row === undefined ? undefined : provider.summarise(row, coordinator.working).name
    },

    noteTurn(jobId, active, pending = null) {
      if (active) {
        unprompted.delete(jobId)
        coordinator.begin(jobId)
      } else {
        if (pending !== null) stopPending.set(jobId, pending)
        coordinator.end(jobId)
        stopPending.delete(jobId)
      }
      void refresh()
    },

    noteStatus(jobId, status) {
      const percent = provider.readContextPercent(status)
      if (percent === null) contextPercent.delete(jobId)
      else contextPercent.set(jobId, percent)
      deps.onChange()
    },

    startedEmpty: (jobId) => void unprompted.add(jobId),
    spoke: (jobId) => void unprompted.delete(jobId),
    hasHadNoTurn: (jobId) => unprompted.has(jobId),

    onTurnEnd(listener) {
      turnEnds.add(listener)
      return () => turnEnds.delete(listener)
    },

    reset() {
      for (const id of [...coordinator.working]) coordinator.forget(id)
      unprompted.clear()
      contextPercent.clear()
      if (idleRecheck !== null) {
        clearTimeout(idleRecheck)
        idleRecheck = null
      }
      rows = []
      seededFor = null
    },
  }
}
