/**
 * What a Holi's run changed, for its entry on the Holi's page: Review changes
 * (the turn review drawer over the run's range) and Revert (the vault back as
 * it was before the run).
 *
 * A run is a background session, and each of its turns is recorded by the
 * vault's turn coordinator under its job id. The run's range is the first
 * turn's base to the last turn's end; nothing here is stored, the files are
 * asked of git when shown.
 */
import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { activeRemoteAtom } from '@/plugin-api'
import { agentCap } from '../agent-cap'
import { reviewTurnAtom, turnReviewOpenAtom, type Turn, type TurnFile } from './turns'

/** Each run's range, by its job id. */
export const runRangesAtom = atom<Record<string, Turn>>({})

/** What each run's range changed, by job id. */
export const runFilesAtom = atom<Record<string, TurnFile[]>>({})

/** Runs the person kept or reverted, by job id: their changes are dealt with.
 *  This machine's. */
export const runsReviewedAtom = atomWithStorage<Record<string, 'kept' | 'reverted'>>(
  'holi.agents.reviewed',
  {},
)

/** Fold the turn log into one range per job id: the log is newest first, so
 *  a session's first record is its last turn, its last record its first. */
export function rangesOf(turns: readonly Turn[]): Record<string, Turn> {
  const out: Record<string, Turn> = {}
  for (const turn of turns) {
    if (turn.sessionId === undefined) continue
    const have = out[turn.sessionId]
    out[turn.sessionId] =
      have === undefined
        ? { ...turn }
        : {
            ...have,
            base: turn.base,
            overlapped: have.overlapped === true || turn.overlapped === true,
          }
  }
  return out
}

/** Re-read the turn log and the files of the runs `jobIds`. Called as the
 *  page opens and when a run's turn ends. */
export const loadRunChangesAtom = atom(null, async (get, set, jobIds: readonly string[]) => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return
  const ranges = rangesOf(await agentCap.turns(remote))
  set(runRangesAtom, ranges)
  const known = get(runFilesAtom)
  const next = { ...known }
  await Promise.all(
    jobIds.map(async (id) => {
      const range = ranges[id]
      // No turn recorded under it: the run changed nothing.
      if (range === undefined) {
        next[id] = []
        return
      }
      next[id] = await agentCap
        .turnFiles(remote, { base: range.base, end: range.end })
        .catch(() => [])
    }),
  )
  set(runFilesAtom, next)
})

/** Review changes: the turn review drawer, over the run's whole range. */
export const reviewRunAtom = atom(null, (get, set, jobId: string) => {
  const range = get(runRangesAtom)[jobId]
  if (range === undefined) return
  set(reviewTurnAtom, range)
  set(turnReviewOpenAtom, true)
})

/** Keep: what the run changed stays, and its entry stops asking. */
export const keepRunAtom = atom(null, (_get, set, jobId: string) =>
  set(runsReviewedAtom, (r) => ({ ...r, [jobId]: 'kept' })),
)

/**
 * Revert: the vault back as it was before the run. A file the run created is
 * deleted; one it changed or deleted gets its text from before the run. Each
 * is a write and a new commit, the turn review's own revert, never a rewrite
 * of history.
 */
export const revertRunAtom = atom(
  null,
  async (get, set, jobId: string): Promise<{ ok: true } | { ok: false; message: string }> => {
    const remote = get(activeRemoteAtom)
    const range = get(runRangesAtom)[jobId]
    const files = get(runFilesAtom)[jobId]
    if (remote === null || range === undefined || files === undefined) {
      return { ok: false, message: 'There is nothing of this run to take back.' }
    }
    for (const file of files) {
      if (file.status === 'A') {
        await agentCap.revert(remote, { path: file.path, delete: true })
        continue
      }
      const { before } = await agentCap.turnDiff(remote, {
        base: range.base,
        end: range.end,
        path: file.path,
      })
      await agentCap.revert(remote, { path: file.path, text: before })
    }
    set(runsReviewedAtom, (r) => ({ ...r, [jobId]: 'reverted' }))
    return { ok: true }
  },
)
