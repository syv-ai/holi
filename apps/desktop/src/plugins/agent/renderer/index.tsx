/**
 * The agent's renderer side (docs/features/agent-sessions.md): the sidebar's
 * Agents mode (its sidebar, its main view and the status the mode toggle
 * reports), with a slot other plugins fill without the agent knowing them;
 * its terminal tab, the surface `agent`, kept mounted, one per
 * terminal; its nav item; its turn review drawer; leaving a vault asks while a
 * session is busy; it provides the agent service; and the palette lists its
 * live sessions.
 */
import { atom } from 'jotai'
import { Bot } from 'lucide-react'
import {
  activeRemoteAtom,
  appModeAtom,
  type Command,
  type RendererPlugin,
  type SurfaceTabLook,
} from '@/plugin-api'
import { AGENT_INFO } from '../info'
import { AgentSurface } from './AgentSurface'
import { agentIndicator } from './lib/notices'
import { SchedulesSection, schedulesEpochAtom } from './SchedulesSection'
import { AGENT_SERVICE } from './service'
import { SessionActions } from './SessionActions'
import { AgentsMain } from './agents/AgentsMain'
import { AgentsSidebar } from './agents/AgentsSidebar'
import { DocumentHoliActions } from './agents/DocumentHoliActions'
import { HoliDialogs } from './agents/HoliDialogs'
import { agentsStatusAtom } from './state/agents-status'
import { holiEvents, holisVault } from './state/holis'
import { newViewSessionAtom } from './state/session-view'
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
import { TurnReview } from './TurnReview'

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
  // ⌘N is a new session only in Agents mode; in Documents it stays free.
  {
    id: 'agent.new',
    label: 'New session',
    hotkey: '⌘N',
    when: (get) => get(appModeAtom) === 'agents',
    run: (_get, set) => void set(newViewSessionAtom),
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

/** The agent's terminals and the vault's Holis while it is open. */
function vault(
  remote: string,
  store: Parameters<NonNullable<RendererPlugin['vault']>>[1],
): () => void {
  const undo = [agentVault(remote, store), holisVault(remote, store)]
  return () => {
    for (const u of undo) u()
  }
}

export const agentRenderer: RendererPlugin = {
  info: AGENT_INFO,
  events: {
    ...agentEvents,
    ...holiEvents,
    // A schedule ran, or was turned on or off: the section asks again.
    schedules: ({ remote }, store) => {
      if (remote === store.get(activeRemoteAtom)) store.set(schedulesEpochAtom, (n) => n + 1)
    },
  },
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
  },
  drawers: [TurnReview, HoliDialogs],
  // Send to Holi, in a document's Agent menu.
  documentActions: DocumentHoliActions,
  settingsSections: [
    {
      id: 'schedules',
      label: 'Schedules',
      headings: [{ id: 'scheduled-agents', title: 'Scheduled agents' }],
      // The schedules themselves are files the section links to one by one;
      // whether each runs here is the machine's, outside the vault.
      files: [],
      Component: ({ remote }) => <SchedulesSection remote={remote} />,
    },
  ],
  leaveGuard: agentLeaveGuardAtom,
  vault,
  agent: AGENT_SERVICE,
  commands: COMMANDS,
  palette: {
    items: atom((get) =>
      get(agentSessionsAtom).map((s) => ({ key: s.id, name: s.name, dot: agentIndicator(s).dot })),
    ),
    open: atom(null, (_get, set, id: string) => void set(openSessionAtom, id)),
  },
}
