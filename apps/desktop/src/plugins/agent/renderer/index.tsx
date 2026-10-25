/**
 * The agent's renderer side (docs/features/agent-sessions.md): the sidebar's
 * Agents mode (its sidebar with the Inbox and the sessions, its main view and
 * the status the mode toggle reports), with a slot other plugins fill without
 * the agent knowing them (Automations, Holis); its home, the new-session
 * page, and the session view, each session in its terminal;
 * its terminal tab, the surface `agent`, kept mounted, one per
 * terminal; its nav item; its turn review drawer; leaving a vault asks while a
 * session is busy; it provides the agent service; and the palette lists its
 * live sessions.
 */
import { atom } from 'jotai'
import { Bot } from 'lucide-react'
import { appModeAtom, type Command, type RendererPlugin, type SurfaceTabLook } from '@/plugin-api'
import { AGENT_INFO } from '../info'
import { AgentSurface } from './AgentSurface'
import { agentIndicator } from './lib/notices'
import { AGENT_SERVICE } from './service'
import { SessionActions } from './SessionActions'
import { AgentsMain } from './agents/AgentsMain'
import { AgentsSidebar } from './agents/AgentsSidebar'
import { agentsStatusAtom } from './state/agents-status'
import { newSessionAtom, sessionListVault, sessionTabLookAtom } from './state/session-list'
import {
  AGENT_SURFACE,
  agentEvents,
  agentLeaveGuardAtom,
  agentSessionsAtom,
  agentTerminalsAtom,
  agentVault,
  terminalLabel,
} from './state/sessions'
import { openSessionAtom, showAgentsAtom } from './state/send'
import { agentMenuEntriesAtom, runAgentMenuEntryAtom } from './state/command-menu'
import { loadProvidersAtom, pickedProviderAtom, providersAtom } from './state/providers'
import { startConversationViewAtom } from './state/session-view'
import { TurnReview } from './TurnReview'
import { AgentStatusItem } from './sessions/AgentStatusItem'

/**
 * Each terminal's tab, in Holi's names so a tab and its sidebar row agree. A
 * tab opened for a session that is still live carries its state: the same
 * dot and sentence, from the same derivation, as its row. Anything else (the
 * list, or a session that has gone) keeps the surface's glyph.
 */
const tabLooksAtom = atom((get): readonly SurfaceTabLook[] => {
  const sessions = get(agentSessionsAtom)
  return get(agentTerminalsAtom).map((t) => {
    const label = terminalLabel(t, sessions)
    const session = sessions.find((s) => s.id === t.launchedFor)
    if (session === undefined) return { id: t.id, label }
    const indicator = agentIndicator(session)
    return { id: t.id, label, dot: indicator.dot, tooltip: indicator.title }
  })
})

const COMMANDS: readonly Command[] = [
  // Bound here because an agent tab is mounted only while it is open, so the
  // shortcut that OPENS one cannot live inside it. The agent list: where
  // sessions are started and picked up.
  {
    id: 'agent.show',
    label: 'Go to the agents',
    hotkey: '⌘J',
    firstKey: 3,
    run: (_get, set) => set(appModeAtom, 'agents'),
  },
  // ⌘N is core's: the shell sends it here on the Agents side (`newSession`).
  {
    id: 'agent.new',
    label: 'New session',
    run: (_get, set) => void set(newSessionAtom),
  },
  {
    id: 'agent.terminal',
    label: 'Open the agents list in a terminal',
    run: (_get, set) => {
      set(appModeAtom, 'documents')
      void set(showAgentsAtom)
    },
  },
]

export const agentRenderer: RendererPlugin = {
  info: AGENT_INFO,
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
      tabs: tabLooksAtom,
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
  agentsMode: {
    sidebar: AgentsSidebar,
    main: AgentsMain,
    status: agentsStatusAtom,
    tabLook: sessionTabLookAtom,
    newSession: newSessionAtom,
  },
  drawers: [TurnReview],
  statusItems: [{ id: 'sessions', side: 'right', order: 10, Component: AgentStatusItem }],
  leaveGuard: agentLeaveGuardAtom,
  // The agent's terminals and the session list's turn ends while the vault
  // is open.
  vault: (remote, store) => {
    const offAgent = agentVault(remote, store)
    const offList = sessionListVault(store)
    void store.set(loadProvidersAtom)
    return () => {
      offList()
      offAgent()
      store.set(providersAtom, { kind: 'loading' })
      store.set(pickedProviderAtom, null)
    }
  },
  // The command menu's Ask the agent and an app card's Ask about this app: a
  // session whose first turn is the ask, in the machine's default agent.
  agentsSlot: { start: startConversationViewAtom },
  agent: AGENT_SERVICE,
  commands: COMMANDS,
  palette: {
    items: atom((get) =>
      get(agentSessionsAtom).map((s) => ({ key: s.id, name: s.name, dot: agentIndicator(s).dot })),
    ),
    open: atom(null, (_get, set, id: string) => void set(openSessionAtom, id)),
  },
  commandMenu: { entries: agentMenuEntriesAtom, run: runAgentMenuEntryAtom },
}
