/**
 * The agent's last turn, and what it changed.
 *
 * A turn is a **commit range**, and nothing here caches what that range
 * contains: the file list and every diff are asked of git when shown, since any
 * held copy goes stale on the next turn, autosave, or pull.
 *
 * Re-declares its row types, as `state/history.ts` does: these are main-process
 * shapes and the renderer does not import from main.
 */
import { atom } from 'jotai'
import { agentCap } from '../agent-cap'
import { activeRemoteAtom } from '@/plugin-api'

/** One recorded turn: two shas and when it ended. */
export interface Turn {
  base: string
  end: string
  /** ISO 8601. */
  at: string
  /** Which session ran it. Absent on older records, which get no chip:
   *  there is no tab for them to sit under. */
  sessionId?: string
  /** Another session's turn was open at the same instant, so this range contains
   *  work this turn did not do. Absent reads as false. */
  overlapped?: boolean
}

/** A turn IS its range, so that is what identifies one. Two sessions that shared
 *  a settle commit share an `end` and differ only in `base`. */
export const rangeKey = (turn: Turn): string => `${turn.base}..${turn.end}`

/** One file's change across the turn. */
export interface TurnFile {
  path: string
  added: number
  removed: number
  /** `A` | `M` | `D` | `R<score>`. A rename reports its NEW path. */
  status: string
}

/** A file's before/after across the turn, fed to the merge view. */
export interface TurnDiff {
  before: string
  after: string
}

export const turnReviewOpenAtom = atom(false)

/**
 * The newest turn per session, keyed by session id.
 *
 * The log is per vault and newest-first, so this is a fold over it rather than N
 * queries. A chip belongs to a tab, so a record that names no session has
 * nowhere to go and is skipped.
 */
export const latestTurnsAtom = atom<Record<string, Turn>>({})

/** How many files each turn's range touched, keyed by `rangeKey`. Each chip
 *  needs its own count, and two chips can name the same range. */
export const turnCountsAtom = atom<Record<string, number>>({})

/** The turn the review panel is showing: whichever chip was clicked. */
export const reviewTurnAtom = atom<Turn | null>(null)

export const turnFilesAtom = atom<TurnFile[]>([])
export const selectedTurnPathAtom = atom<string | null>(null)
/** The selected file's diff, or null while none is picked or one is loading. */
export const turnDiffAtom = atom<TurnDiff | null>(null)

// ------------------------------------------------------------------- write atoms

/** The newest record for each session. The log is already newest-first and is
 *  never re-sorted here, so the first record naming a session is that session's
 *  latest. */
export const loadLatestTurnsAtom = atom(null, async (get, set) => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return
  const turns = await agentCap.turns(remote)
  const latest: Record<string, Turn> = {}
  for (const turn of turns) {
    if (turn.sessionId === undefined) continue
    latest[turn.sessionId] ??= turn
  }
  set(latestTurnsAtom, latest)
})

/**
 * How many files one turn's range touched.
 *
 * Cached by range rather than by session, so the same range asked twice is one
 * query. Empty is a real answer: see `loadTurnFilesAtom`.
 */
export const loadTurnCountAtom = atom(null, async (get, set, turn: Turn) => {
  const key = rangeKey(turn)
  const remote = get(activeRemoteAtom)
  if (remote === null || get(turnCountsAtom)[key] !== undefined) return
  const files = await agentCap.turnFiles(remote, { base: turn.base, end: turn.end })
  set(turnCountsAtom, (counts) => ({ ...counts, [key]: files.length }))
})

/**
 * What the turn changed. Empty is a real answer, not a failure: a range whose
 * shas are gone (a reset, a re-clone) comes back from the router as `[]`.
 */
export const loadTurnFilesAtom = atom(null, async (get, set) => {
  const turn = get(reviewTurnAtom)
  const remote = get(activeRemoteAtom)
  if (turn === null || remote === null) return
  const files = await agentCap.turnFiles(remote, { base: turn.base, end: turn.end })
  // The turn may have been replaced by a newer one while this was in flight.
  if (get(reviewTurnAtom) === turn) set(turnFilesAtom, files)
})

/** One file's diff across the turn. */
export const loadTurnDiffAtom = atom(null, async (get, set, path: string) => {
  const turn = get(reviewTurnAtom)
  const remote = get(activeRemoteAtom)
  if (turn === null || remote === null) return
  set(selectedTurnPathAtom, path)
  set(turnDiffAtom, null)
  const diff = await agentCap.turnDiff(remote, { base: turn.base, end: turn.end, path })
  // Two rows clicked in quick succession: the slower answer must not land on the
  // faster one's row. Same guard `history.ts` puts on its own diff load.
  if (get(selectedTurnPathAtom) === path && get(reviewTurnAtom) === turn) set(turnDiffAtom, diff)
})

/**
 * Write back what the reviewer resolved to, as a **new commit**, never a
 * rewrite (`docs/features/history.md`).
 *
 * **The buffers are deliberately NOT flushed first**, unlike `history.ts`'s
 * restore. A turn revert takes back what the AGENT did, not the reader's unsaved
 * edits: flushing would write them to disk and then overwrite them with the
 * resolved text. Instead the write hits disk, the watcher reports it, and
 * `decideReload` runs (clean buffer reloads, dirty one 3-way merges, an overlap
 * routes to reconcile).
 *
 * The file list is then re-asked: the revert has just minted a commit inside the
 * range being looked at.
 */
export const revertFileAtom = atom(
  null,
  async (get, set, { path, text }: { path: string; text: string }) => {
    const remote = get(activeRemoteAtom)
    if (remote === null) return
    await agentCap.revert(remote, { path, text })
    await set(loadTurnFilesAtom)
  },
)

/** Switching vault must not leave the previous one's turns on screen, nor its
 *  counts: a range from another vault is one this git has never heard of. */
export const resetTurnReviewAtom = atom(null, (_get, set) => {
  set(latestTurnsAtom, {})
  set(turnCountsAtom, {})
  set(reviewTurnAtom, null)
  set(turnFilesAtom, [])
  set(selectedTurnPathAtom, null)
  set(turnDiffAtom, null)
})
