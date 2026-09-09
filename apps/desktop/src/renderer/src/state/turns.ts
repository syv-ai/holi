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
import { flushAllBuffers } from '../lib/buffer-registry'
import { trpc } from '../lib/trpc'
import { activeRemoteAtom } from './vaults'

/** One recorded turn: two shas and when it ended. */
export interface Turn {
  base: string
  end: string
  /** ISO 8601. */
  at: string
}

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
export const latestTurnAtom = atom<Turn | null>(null)
export const turnFilesAtom = atom<TurnFile[]>([])
export const selectedTurnPathAtom = atom<string | null>(null)
/** The selected file's diff, or null while none is picked or one is loading. */
export const turnDiffAtom = atom<TurnDiff | null>(null)

// ------------------------------------------------------------------- write atoms

/** The newest record, which is the turn worth reviewing. The log is already
 *  newest-first and is never re-sorted here. */
export const loadLatestTurnAtom = atom(null, async (_get, set) => {
  const turns = await trpc.turns.list.query()
  set(latestTurnAtom, turns[0] ?? null)
})

/**
 * What the turn changed. Empty is a real answer, not a failure: a range whose
 * shas are gone — a reset, a re-clone — is a turn whose history is gone, and the
 * router already turns that into `[]` rather than an error.
 */
export const loadTurnFilesAtom = atom(null, async (get, set) => {
  const turn = get(latestTurnAtom)
  if (turn === null) return
  const files = await trpc.turns.files.query({ base: turn.base, end: turn.end })
  // The turn may have been replaced by a newer one while this was in flight.
  if (get(latestTurnAtom) === turn) set(turnFilesAtom, files)
})

/** One file's diff across the turn. */
export const loadTurnDiffAtom = atom(null, async (get, set, path: string) => {
  const turn = get(latestTurnAtom)
  if (turn === null) return
  set(selectedTurnPathAtom, path)
  set(turnDiffAtom, null)
  const diff = await trpc.turns.fileDiff.query({ base: turn.base, end: turn.end, path })
  // Two rows clicked in quick succession: the slower answer must not land on the
  // faster one's row. Same guard `history.ts` puts on its own diff load.
  if (get(selectedTurnPathAtom) === path && get(latestTurnAtom) === turn) set(turnDiffAtom, diff)
})

/**
 * Write back what the reviewer resolved to, as a **new commit** — never a
 * rewrite (`prd/vaults-sync.md` §History).
 *
 * The live buffers are flushed first so the editor's external-write reconcile
 * reloads the file cleanly (clean buffer → silent reload) instead of 3-way
 * merging its own revert, which is what `history.ts`'s restore does and for the
 * same reason. The file list is then re-asked: the revert has just minted a
 * commit inside the range being looked at.
 */
export const revertFileAtom = atom(
  null,
  async (get, set, { path, text }: { path: string; text: string }) => {
    const remote = get(activeRemoteAtom)
    if (remote === null) return
    await flushAllBuffers()
    await trpc.turns.revert.mutate({ remote, path, text })
    await set(loadTurnFilesAtom)
  },
)

/** Switching vault must not leave the previous one's turn under review. */
export const resetTurnReviewAtom = atom(null, (_get, set) => {
  set(latestTurnAtom, null)
  set(turnFilesAtom, [])
  set(selectedTurnPathAtom, null)
  set(turnDiffAtom, null)
})
