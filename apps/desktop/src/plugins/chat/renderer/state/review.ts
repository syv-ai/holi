/**
 * What a chat's last turn changed, for its sidebar row (`+135 −21`) and its
 * review card (Keep, Revert). The turn is the commit range the agent's turn
 * coordinator recorded under the chat's id; nothing here is stored.
 */
import { atom } from 'jotai'
import { activeRemoteAtom } from '@/plugin-api'
import { agentTurnsCap, type Turn, type TurnFile } from '../chat-cap'
import { updateChatAtom } from './chats'

export interface TurnChurn {
  key: string
  turn: Turn
  files: TurnFile[]
  added: number
  removed: number
}

/** Each chat's last turn's files, by chat id. */
export const churnAtom = atom<Record<string, TurnChurn>>({})

/** Re-read the turn log and the changed chats' files. Called when a chat's
 *  turn ends, and when the view opens. */
export const refreshChurnAtom = atom(null, async (get, set) => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return
  const latest: Record<string, Turn> = {}
  for (const turn of await agentTurnsCap.turns(remote)) {
    if (turn.sessionId !== undefined) latest[turn.sessionId] ??= turn
  }
  const known = get(churnAtom)
  const next: Record<string, TurnChurn> = { ...known }
  await Promise.all(
    Object.entries(latest).map(async ([id, turn]) => {
      const key = `${turn.base}..${turn.end}`
      if (known[id]?.key === key) return
      const files = await agentTurnsCap
        .turnFiles(remote, { base: turn.base, end: turn.end })
        .catch(() => [])
      next[id] = {
        key,
        turn,
        files,
        added: files.reduce((n, f) => n + f.added, 0),
        removed: files.reduce((n, f) => n + f.removed, 0),
      }
    }),
  )
  set(churnAtom, next)
})

/** Keep what the turn did: it leaves Ready for review. */
export const keepTurnAtom = atom(null, async (_get, set, id: string) =>
  set(updateChatAtom, { id, reviewed: true }),
)

/**
 * Take the whole turn back: the vault as it was before it. A file the turn
 * created is deleted; one it changed or deleted gets its text from before the
 * turn. Each is a write and a new commit, never a rewrite of history.
 */
export const revertTurnAtom = atom(null, async (get, set, id: string) => {
  const remote = get(activeRemoteAtom)
  const churn = get(churnAtom)[id]
  if (remote === null || churn === undefined) {
    return { ok: false as const, message: 'There is no turn to take back.' }
  }
  const { turn } = churn
  for (const file of churn.files) {
    if (file.status === 'A') {
      await agentTurnsCap.revert(remote, { path: file.path, delete: true })
      continue
    }
    const { before } = await agentTurnsCap.turnDiff(remote, {
      base: turn.base,
      end: turn.end,
      path: file.path,
    })
    await agentTurnsCap.revert(remote, { path: file.path, text: before })
  }
  await set(updateChatAtom, { id, reviewed: true })
  return { ok: true as const }
})
