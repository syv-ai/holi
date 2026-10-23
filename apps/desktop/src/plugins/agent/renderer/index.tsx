/**
 * The agent's renderer side (docs/features/agent-sessions.md): the lists of
 * sessions and what the agents have to say while the vault is open, leaving a
 * vault asks while a session is busy, and the schedules in settings. What is
 * drawn of the sessions is the `agent-ui` plugin's, and so is the agent
 * service every "Ask" goes through: an ask lands in a chat, which only it can
 * show. A plugin that draws the agent imports `public.ts` alone, and fills
 * `agentPageAtom` so the agent's own surfaces can open a session. The inbox
 * (docs/features/agent-inbox.md) is the surface `inbox`, with a nav item that
 * counts what is unread.
 *
 * The quick agent (docs/features/quick-agent.md) is its page `quick`, the
 * window main opens at the pointer, its page `dock`, the dots at the edge of
 * the screen, its settings section, and the dock's key in the main window.
 */
import { atom } from 'jotai'
import { Inbox } from 'lucide-react'
import { activeRemoteAtom, type RendererPlugin } from '@/plugin-api'
import { AGENT_INFO } from '../info'
import { InboxView } from './InboxView'
import { SchedulesSection, schedulesEpochAtom } from './SchedulesSection'
import { agentEvents, agentLeaveGuardAtom, agentVault } from './state/sessions'
import { followPendingOpen } from './state/send'
import { answerDockKey } from './quick/keys'
import { QuickDock } from './quick/QuickDock'
import { QuickPanel } from './quick/QuickPanel'
import { QuickSettings } from './quick/QuickSettings'
import { inboxAtom, inboxEvents, inboxVault, INBOX_SURFACE } from './state/inbox'

export const agentRenderer: RendererPlugin = {
  info: AGENT_INFO,
  events: {
    ...agentEvents,
    ...inboxEvents,
    // A schedule ran, or was turned on or off: the section asks again.
    schedules: ({ remote }, store) => {
      if (remote === store.get(activeRemoteAtom)) store.set(schedulesEpochAtom, (n) => n + 1)
    },
  },
  surfaces: [
    {
      kind: INBOX_SURFACE,
      label: 'Inbox',
      icon: Inbox,
      render: InboxView,
    },
  ],
  rail: [
    // Quiet: there only while it holds something, counting what is unread.
    {
      surface: INBOX_SURFACE,
      order: 65,
      visible: atom((get) => get(inboxAtom).entries.length > 0),
      badge: atom((get) => {
        const unread = get(inboxAtom).unread
        return unread === 0 ? null : { count: unread }
      }),
    },
  ],
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
  leaveGuard: agentLeaveGuardAtom,
  // The lists, and what the agents have to say while the vault is open.
  vault: (remote, store) => {
    const off = [
      agentVault(remote, store),
      followPendingOpen(remote, store),
      inboxVault(remote, store),
      answerDockKey(remote, store),
    ]
    return () => off.forEach((undo) => undo())
  },
  pages: { quick: QuickPanel, dock: QuickDock },
}
