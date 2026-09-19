/**
 * The agent's last turn, and what it changed (D88).
 *
 * A turn is a **commit range**, and nothing here caches what that range
 * contains: the file list and every diff are asked of git at the moment they are
 * shown. Holding them would be a second copy of an answer git already has, and
 * one that goes stale the moment the agent's next turn, an autosave, or a pull
 * touches the tree.
 *
 * Shaped after `state/history.ts`, which answers the same questions about a
 * commit, and re-declares its own row types for the same reason that file does:
 * these are main-process shapes and the renderer does not import from main.
 */
import { atom } from 'jotai'
import { trpc } from '../lib/trpc'
import { activeRemoteAtom } from './vaults'

/** One recorded turn: two shas and when it ended. */
export interface Turn {
  base: string
  end: string
  /** ISO 8601. */
  at: string
  /** Which session ran it (D100). Absent on every record written before a vault
   *  could run more than one, which is why those records have no chip: there is
   *  no tab for them to sit under. One turn from any session fixes that. */
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
 * The newest turn per session, keyed by session id (D100).
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
export const loadLatestTurnsAtom = atom(null, async (_get, set) => {
  const turns = await trpc.turns.list.query()
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
 * Cached by range rather than by session: two sessions whose turns shared a
 * settle commit ask about two different ranges, and the same range asked twice
 * is one query. Empty is a real answer — a range whose shas are gone is a turn
 * whose history is gone — and the router already turns that into `[]`.
 */
export const loadTurnCountAtom = atom(null, async (get, set, turn: Turn) => {
  const key = rangeKey(turn)
  if (get(turnCountsAtom)[key] !== undefined) return
  const files = await trpc.turns.files.query({ base: turn.base, end: turn.end })
  set(turnCountsAtom, (counts) => ({ ...counts, [key]: files.length }))
})

/**
 * What the turn changed. Empty is a real answer, not a failure: a range whose
 * shas are gone — a reset, a re-clone — is a turn whose history is gone, and the
 * router already turns that into `[]` rather than an error.
 */
export const loadTurnFilesAtom = atom(null, async (get, set) => {
  const turn = get(reviewTurnAtom)
  if (turn === null) return
  const files = await trpc.turns.files.query({ base: turn.base, end: turn.end })
  // The turn may have been replaced by a newer one while this was in flight.
  if (get(reviewTurnAtom) === turn) set(turnFilesAtom, files)
})

/** One file's diff across the turn. */
export const loadTurnDiffAtom = atom(null, async (get, set, path: string) => {
  const turn = get(reviewTurnAtom)
  if (turn === null) return
  set(selectedTurnPathAtom, path)
  set(turnDiffAtom, null)
  const diff = await trpc.turns.fileDiff.query({ base: turn.base, end: turn.end, path })
  // Two rows clicked in quick succession: the slower answer must not land on the
  // faster one's row. Same guard `history.ts` puts on its own diff load.
  if (get(selectedTurnPathAtom) === path && get(reviewTurnAtom) === turn) set(turnDiffAtom, diff)
})

/**
 * Write back what the reviewer resolved to, as a **new commit** — never a
 * rewrite (`prd/vaults-sync.md` §History).
 *
 * **The buffers are deliberately NOT flushed first**, which is where this parts
 * company with `history.ts`'s restore. Restore replaces a file with an older
 * version, so the user is discarding the current state on purpose and a flush
 * followed by a clean reload is the coherent thing. A turn revert takes back
 * what the AGENT did, and the reader's own unsaved edits are not what is being
 * taken back: flushing would write them to disk and then overwrite them with the
 * resolved text, losing them silently.
 *
 * So a file open with a dirty buffer gets no special case at all. The write hits
 * disk, the watcher reports it, and `decideReload` runs — a clean buffer reloads
 * silently, a dirty one 3-way merges, an overlap routes to reconcile. That
 * machinery exists and this is the case it was built for.
 *
 * The file list is then re-asked: the revert has just minted a commit inside the
 * range being looked at.
 */
export const revertFileAtom = atom(
  null,
  async (get, set, { path, text }: { path: string; text: string }) => {
    const remote = get(activeRemoteAtom)
    if (remote === null) return
    await trpc.turns.revert.mutate({ remote, path, text })
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
