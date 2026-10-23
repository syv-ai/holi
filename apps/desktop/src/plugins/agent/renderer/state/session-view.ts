/**
 * Background sessions as the Agents view shows them: in a terminal of the
 * view's own, so a session's window there never fights a Documents tab for
 * the same xterm. A New session is started here and lands in the view.
 */
import { atom } from 'jotai'
import { activeRemoteAtom, agentsSlotsAtom, appModeAtom } from '@/plugin-api'
import { agentCap } from '../agent-cap'
import { agentsViewAtom, viewTerminalsAtom } from './agents-view'
import { agentGeometryAtom } from './sessions'
import { respawnSessionAtom, type AgentResult } from './send'

/** ⌘N in Agents mode, and the sidebar's New session: the mode's home when a
 *  plugin offers one there (the chat's new-session page, the session UI),
 *  else a background session waiting for its first prompt, shown in the view. */
export const newViewSessionAtom = atom(null, async (get, set): Promise<AgentResult> => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return { ok: false, message: 'No vault is open.' }
  if (get(agentsSlotsAtom).some((s) => s.home !== undefined)) {
    set(appModeAtom, 'agents')
    set(agentsViewAtom, { kind: 'home' })
    return { ok: true }
  }
  const res = await agentCap.start(remote, get(agentGeometryAtom))
  if (!res.ok) return res
  set(viewTerminalsAtom, (t) => ({ ...t, [res.sessionId]: res.terminalId }))
  set(appModeAtom, 'agents')
  set(agentsViewAtom, { kind: 'session', id: res.sessionId })
  return { ok: true }
})

/** Show a session in the Agents view (a plugin's run, through the agent
 *  service): live, as it is; finished, brought back with `claude respawn`
 *  first, its conversation intact. */
export const showSessionAtom = atom(
  null,
  async (_get, set, args: { session: string; live: boolean }): Promise<AgentResult> => {
    if (!args.live) {
      const res = await set(respawnSessionAtom, args.session)
      if (!res.ok) return res
    }
    set(appModeAtom, 'agents')
    set(agentsViewAtom, { kind: 'session', id: args.session })
    return { ok: true }
  },
)
