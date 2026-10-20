/**
 * Background sessions as the Agents view shows them: in a terminal of the
 * view's own, so a session's window there never fights a Documents tab for
 * the same xterm. A New session is started here and lands in the view.
 */
import { atom } from 'jotai'
import { activeRemoteAtom, appModeAtom } from '@/plugin-api'
import { agentCap } from '../agent-cap'
import { agentsViewAtom, viewTerminalsAtom } from './agents-view'
import { agentGeometryAtom } from './sessions'
import { openSessionAtom, respawnSessionAtom, type AgentResult } from './send'

/** ⌘N in Agents mode, and the sidebar's New session: a background session
 *  waiting for its first prompt, shown in the view. */
export const newViewSessionAtom = atom(null, async (get, set): Promise<AgentResult> => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return { ok: false, message: 'No vault is open.' }
  const res = await agentCap.start(remote, get(agentGeometryAtom))
  if (!res.ok) return res
  set(viewTerminalsAtom, (t) => ({ ...t, [res.sessionId]: res.terminalId }))
  set(appModeAtom, 'agents')
  set(agentsViewAtom, { kind: 'session', id: res.sessionId })
  return { ok: true }
})

/** Open a Holi's run in an agent tab beside the documents: live, as it is;
 *  finished, brought back with `claude respawn` first, its conversation
 *  intact. */
export const openRunSessionAtom = atom(
  null,
  async (_get, set, args: { jobId: string; live: boolean }): Promise<AgentResult> => {
    if (!args.live) {
      const res = await set(respawnSessionAtom, args.jobId)
      if (!res.ok) return res
    }
    set(appModeAtom, 'documents')
    return set(openSessionAtom, args.jobId)
  },
)
