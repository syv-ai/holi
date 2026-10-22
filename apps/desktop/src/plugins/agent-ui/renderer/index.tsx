/**
 * The agent's interface (docs/features/agent-sessions.md): its page is the
 * surface `agent`, kept mounted, the chat of one session; the stack of
 * bubbles for all of them floats over every tab, with the smaller chat and
 * the notices beside it, or, where this machine chose it (`sessionList`),
 * the live sessions are rows in the sidebar; its nav item runs `agent.show`;
 * its turn review is an overlay; the palette lists its live sessions; and it
 * provides the agent service every "Ask" goes through, since an ask lands in
 * a chat. What the sessions are (lists, events, the leave guard) is the
 * `agent` plugin's, read through its `public.ts`.
 */
import { atom } from 'jotai'
import { Bot } from 'lucide-react'
import type { Command, RendererPlugin } from '@/plugin-api'
import { agentIndicator, agentPageAtom, agentSessionsAtom } from '../../agent/renderer/public'
import { AGENT_SERVICE } from './service'
import { AGENT_PAGE, showAgentsAtom, showSessionAtom, startSessionAtom } from './state/actions'
import { reportWatching, watchNotices } from './state/notices'
import { AGENT_SURFACE, pageVault } from './state/page'
import { resetTurnReviewAtom, turnReviewOpenAtom } from './state/turns'
import { AGENT_UI_INFO } from '../info'
import { AgentBubbles } from './AgentBubbles'
import { AgentSurface } from './AgentSurface'
import { SessionRows } from './SessionRows'
import { TurnReview } from './TurnReview'

const COMMANDS: readonly Command[] = [
  // Bound here because the page is mounted only while it is open, so the
  // shortcut that OPENS it cannot live inside it.
  {
    id: 'agent.show',
    label: 'Go to the agents',
    hotkey: '⌘J',
    firstKey: 3,
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
  floating: AgentBubbles,
  // Where this machine lists the sessions in the sidebar (`sessionList`)
  // rather than as bubbles. Each draws nothing under the other choice.
  sidebarSection: SessionRows,
  overlays: [TurnReview],
  commands: COMMANDS,
  // While this runs the page is the agent's to land on (the inbox, a
  // schedule's run, the quick panel's "open in Holi" open sessions here), the
  // notices watch the sessions, and main is told whose chat is showing.
  vault: (remote, store) => {
    store.set(agentPageAtom, AGENT_PAGE)
    const off = [watchNotices(remote, store), reportWatching(remote, store)]
    return () => {
      off.forEach((undo) => undo())
      store.set(agentPageAtom, null)
      // What the page showed is this vault's: the next opens on its own.
      pageVault(store)
      store.set(resetTurnReviewAtom)
      store.set(turnReviewOpenAtom, false)
    }
  },
  // Every "Ask" lands in a chat, so the service is the interface's.
  agent: AGENT_SERVICE,
  palette: {
    items: atom((get) =>
      get(agentSessionsAtom).map((s) => ({ key: s.id, name: s.name, dot: agentIndicator(s).dot })),
    ),
    open: atom(null, (_get, set, id: string) => void set(showSessionAtom, id)),
  },
}
