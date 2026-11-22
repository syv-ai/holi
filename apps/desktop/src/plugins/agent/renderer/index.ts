/**
 * The agent's renderer side (docs/features/agent-sessions.md): the sidebar's
 * Agents mode (its sidebar with the Inbox and the sessions, its main view and
 * the status the mode toggle reports), with a slot other plugins fill without
 * the agent knowing them (Automations, Holis); its home, the new-session
 * page, and the session view, each session in its terminal;
 * its terminal tab, the surface `agent`, kept mounted, one per
 * terminal; its nav item; its turn review drawer; leaving a vault asks while a
 * session is busy; and it provides the agent service.
 */
import { atom } from 'jotai'
import { Astroid } from 'lucide-react'
import type { RendererPlugin, SurfaceTabLook } from '@/plugin-api'
import { AGENT_INFO } from '../info'
import { AgentSurface } from './agent-surface'
import { agentIndicator } from './lib/notices'
import { AGENT_SERVICE } from './service'
import { SessionActions } from './session-actions'
import { AgentsView } from './agents/agents-view'
import { agentsViewOf } from './state/agents-view'
import { AgentsSidebar } from './agents/agents-sidebar'
import { agentsStatusAtom } from './state/agents-status'
import { showHistoryAtom } from './state/agents-view'
import { inboxEvents, inboxVault } from './state/inbox'
import { newSessionAtom, sessionListVault, sessionTabLookAtom } from './state/session-list'
import {
  AGENT_SURFACE,
  agentEvents,
  agentLeaveGuardAtom,
  agentSessionsAtom,
  agentTerminalsAtom,
  agentVault,
  terminalLabel,
  type AgentSession,
} from './state/sessions'
import { agentMenuEntriesAtom, runAgentMenuEntryAtom } from './state/command-menu'
import {
  loadProvidersAtom,
  pickedProviderAtom,
  providerEvents,
  providersAtom,
} from './state/providers'
import { startConversationViewAtom } from './state/session-view'
import { TurnReview } from './turn-review'
import { AgentStatusItem } from './sessions/agent-status-item'

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

// The policy is synchronous and receives no store. The vault lifecycle owns
// this lookup, so it reads this window's current sessions, not Jotai's default
// store (the app supplies its own). Claude and Pi RPC can share the id grammar.
let sessionInVault: ((id: string) => AgentSession | undefined) | undefined

export const agentRenderer: RendererPlugin = {
  info: AGENT_INFO,
  events: { ...agentEvents, ...inboxEvents, ...providerEvents },
  surfaces: [
    {
      kind: AGENT_SURFACE,
      label: 'Agents',
      icon: Astroid,
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
      live: atom((get) => get(agentSessionsAtom).length > 0),
    },
  ],
  agentsMode: {
    sidebar: AgentsSidebar,
    main: AgentsView,
    keepsSelectionMounted: (selection) => {
      const view = agentsViewOf(selection)
      return (
        view.kind === 'session' &&
        !(view.id.length === 8 && sessionInVault?.(view.id)?.provider === 'pi')
      )
    },
    status: agentsStatusAtom,
    tabLook: sessionTabLookAtom,
    newSession: newSessionAtom,
    overview: showHistoryAtom,
  },
  drawers: [TurnReview],
  statusItems: [{ id: 'sessions', side: 'right', order: 10, Component: AgentStatusItem }],
  leaveGuard: agentLeaveGuardAtom,
  // The agent's terminals and the session list's turn ends while the vault
  // is open.
  vault: (remote, store) => {
    const lookup = (id: string) => store.get(agentSessionsAtom).find((session) => session.id === id)
    sessionInVault = lookup
    const offAgent = agentVault(remote, store)
    const offList = sessionListVault(store)
    // The inbox's entries: `holi agent notify`, needs-you, mentions.
    const offInbox = inboxVault(remote, store)
    void store.set(loadProvidersAtom)
    return () => {
      if (sessionInVault === lookup) sessionInVault = undefined
      offInbox()
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
  commandMenu: { entries: agentMenuEntriesAtom, run: runAgentMenuEntryAtom },
}
