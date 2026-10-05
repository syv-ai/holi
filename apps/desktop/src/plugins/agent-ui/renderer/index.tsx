/**
 * The agent's interface (docs/features/agent-sessions.md): its page is the
 * surface `agent`, kept mounted, the chat of one session; the stack of
 * bubbles for all of them floats over every tab as its overlay, with the
 * smaller chat and the notices beside it; its nav item runs `agent.show`; its
 * turn review is a drawer; and the palette lists its live sessions. What the
 * sessions are (lists, events, the agent service, the leave guard) is the
 * `agent` plugin's, whose state this reads.
 */
import { atom } from 'jotai'
import { Bot } from 'lucide-react'
import type { Command, RendererPlugin } from '@/plugin-api'
import { agentIndicator } from '../../agent/renderer/lib/notices'
import { openSessionAtom, showAgentsAtom, startSessionAtom } from '../../agent/renderer/state/send'
import { AGENT_SURFACE, agentSessionsAtom } from '../../agent/renderer/state/sessions'
import { AGENT_UI_INFO } from '../info'
import { AgentBubbles } from './AgentBubbles'
import { AgentSurface } from './AgentSurface'
import { TurnReview } from './TurnReview'

const COMMANDS: readonly Command[] = [
  // Bound here because the page is mounted only while it is open, so the
  // shortcut that OPENS it cannot live inside it.
  {
    id: 'agent.show',
    label: 'Go to the agents',
    hotkey: '⌘J',
    run: (_get, set) => void set(showAgentsAtom),
  },
  {
    id: 'agent.new',
    label: 'New session',
    run: (_get, set) => void set(startSessionAtom),
  },
]

export const agentUiRenderer: RendererPlugin = {
  info: AGENT_UI_INFO,
  surfaces: [
    {
      kind: AGENT_SURFACE,
      label: 'Agents',
      icon: Bot,
      render: AgentSurface,
      keepMounted: true,
      unlisted: true,
      keepsFocusedNote: true,
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
  overlay: AgentBubbles,
  drawers: [TurnReview],
  commands: COMMANDS,
  palette: {
    items: atom((get) =>
      get(agentSessionsAtom).map((s) => ({ key: s.id, name: s.name, dot: agentIndicator(s).dot })),
    ),
    open: atom(null, (_get, set, id: string) => void set(openSessionAtom, id)),
  },
}
