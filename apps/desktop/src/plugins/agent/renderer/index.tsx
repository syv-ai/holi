/**
 * The agent's renderer side (docs/features/agent-sessions.md): its tab is the
 * surface `agent`, kept mounted, one per terminal; its nav item runs
 * `agent.show`; its orbs, rows and turn review are a rail section, a sidebar
 * section and a drawer; leaving a vault asks while a session is busy; it
 * provides the agent service; and the palette lists its live sessions.
 *
 * The quick agent (docs/features/quick-agent.md) is its page `quick`, the
 * window main opens at the pointer, its page `dock`, the dots at the edge of
 * the screen, its settings section, and the dock's key in the main window.
 */
import { atom } from 'jotai'
import { Bot } from 'lucide-react'
import type { Command, RendererPlugin, SurfaceTabLook } from '@/plugin-api'
import { AGENT_INFO } from '../info'
import { AgentSurface } from './AgentSurface'
import { agentIndicator } from './lib/notices'
import { AGENT_SERVICE } from './service'
import { SessionActions } from './SessionActions'
import { SessionOrbs } from './SessionOrbs'
import { SessionRows } from './SessionRows'
import {
  AGENT_SURFACE,
  agentEvents,
  agentLeaveGuardAtom,
  agentSessionsAtom,
  agentTerminalsAtom,
  agentVault,
  terminalLabel,
} from './state/sessions'
import { followPendingOpen, openSessionAtom, showAgentsAtom, startSessionAtom } from './state/send'
import { answerDockKey } from './quick/keys'
import { QuickDock } from './quick/QuickDock'
import { QuickPanel } from './quick/QuickPanel'
import { QuickSettings } from './quick/QuickSettings'
import { TurnReview } from './TurnReview'

/** The tree above, the menu below: many sessions scroll rather than squeeze
 *  the tree away. */
function SessionRowsSection(): React.JSX.Element {
  return (
    <div className="max-h-[40%] shrink-0 overflow-y-auto">
      <SessionRows />
    </div>
  )
}

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
    run: (_get, set) => void set(showAgentsAtom),
  },
  {
    id: 'agent.new',
    label: 'New session',
    run: (_get, set) => void set(startSessionAtom),
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
  railSection: SessionOrbs,
  sidebarSection: SessionRowsSection,
  drawers: [TurnReview],
  leaveGuard: agentLeaveGuardAtom,
  vault: (remote, store) => {
    const off = [
      agentVault(remote, store),
      followPendingOpen(remote, store),
      answerDockKey(remote, store),
    ]
    return () => off.forEach((undo) => undo())
  },
  agent: AGENT_SERVICE,
  commands: COMMANDS,
  palette: {
    items: atom((get) =>
      get(agentSessionsAtom).map((s) => ({ key: s.id, name: s.name, dot: agentIndicator(s).dot })),
    ),
    open: atom(null, (_get, set, id: string) => void set(openSessionAtom, id)),
  },
  pages: { quick: QuickPanel, dock: QuickDock },
  settingsSections: [
    {
      id: 'quick-agent',
      label: 'Quick agent',
      headings: [],
      // This machine's: the settings live in Holi's data directory, not in
      // the vault.
      files: [],
      Component: () => <QuickSettings />,
    },
  ],
}
