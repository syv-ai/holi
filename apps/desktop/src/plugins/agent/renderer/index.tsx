/**
 * The agent's renderer side (docs/features/agent-sessions.md): the lists of
 * sessions and what the agents have to say while the vault is open, leaving a
 * vault asks while a session is busy, and it provides the agent service every
 * "Ask" goes through. What is drawn of them is the `agent-ui` plugin's.
 */
import type { RendererPlugin } from '@/plugin-api'
import { AGENT_INFO } from '../info'
import { AGENT_SERVICE } from './service'
import { agentEvents, agentLeaveGuardAtom, agentVault } from './state/sessions'
import { watchNotices } from './state/notices'

export const agentRenderer: RendererPlugin = {
  info: AGENT_INFO,
  events: agentEvents,
  leaveGuard: agentLeaveGuardAtom,
  // The lists, and what the agents have to say while the vault is open.
  vault: (remote, store) => {
    const lists = agentVault(remote, store)
    const notices = watchNotices(remote, store)
    return () => {
      notices()
      lists()
    }
  },
  agent: AGENT_SERVICE,
}
