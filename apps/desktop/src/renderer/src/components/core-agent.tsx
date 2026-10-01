/**
 * The vault's agent, registered through the plugin contract while it is
 * still core (docs/features/agent-sessions.md): its tab is the surface
 * `agent`, kept mounted; its nav item runs `agent.show`; its orbs, rows and
 * turn review are a rail section, a sidebar section and a drawer; leaving a
 * vault asks while a session is busy; it provides the agent service; and
 * its events are the plugin `agent`'s.
 * Installed by `main.tsx` as a core part, so it runs in every vault.
 */
import { atom } from 'jotai'
import { Bot } from 'lucide-react'
import type { AgentServiceSource, RendererPlugin } from '@/plugin-api/types'
import { AgentSurface } from '@/features/agent/AgentSurface'
import { SessionActions } from '@/features/agent/SessionActions'
import { SessionOrbs } from '@/features/agent/SessionOrbs'
import { SessionRows } from '@/features/agent/SessionRows'
import { TurnReview } from '@/features/agent/TurnReview'
import {
  AGENT_SURFACE,
  agentEvents,
  agentLeaveGuardAtom,
  agentSessionsAtom,
  agentVault,
  askTargetsAtom,
  defaultAgentTargetAtom,
} from '@/state/agent'
import { sendToAgentAtom, startSessionAtom } from '@/state/agent-send'

/** The tree above, the menu below: many sessions scroll rather than squeeze
 *  the tree away. */
function SessionRowsSection(): React.JSX.Element {
  return (
    <div className="max-h-[40%] shrink-0 overflow-y-auto">
      <SessionRows />
    </div>
  )
}

const SERVICE: AgentServiceSource = {
  name: 'Claude',
  sessions: agentSessionsAtom,
  targets: atom((get) => ({
    sessions: get(askTargetsAtom),
    default: get(defaultAgentTargetAtom),
  })),
  ask: sendToAgentAtom,
  start: startSessionAtom,
}

export const CORE_AGENT: RendererPlugin = {
  info: { id: 'agent', label: 'Agent', default: true },
  events: agentEvents,
  surfaces: [
    {
      kind: AGENT_SURFACE,
      label: 'Agents',
      icon: Bot,
      render: AgentSurface,
      keepMounted: true,
      unlisted: true,
      headerActions: SessionActions,
    },
  ],
  rail: [
    {
      surface: AGENT_SURFACE,
      order: 60,
      command: 'agent.show',
      live: atom((get) => get(agentSessionsAtom).length > 0),
    },
  ],
  railSection: SessionOrbs,
  sidebarSection: SessionRowsSection,
  drawers: [TurnReview],
  leaveGuard: agentLeaveGuardAtom,
  vault: agentVault,
  agent: SERVICE,
}
