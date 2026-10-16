/**
 * The agent's renderer side (docs/features/agent-sessions.md): the lists of
 * sessions and what the agents have to say while the vault is open, leaving a
 * vault asks while a session is busy, the schedules in settings, and it
 * provides the agent service every "Ask" goes through. What is drawn of the
 * sessions is the `agent-ui` plugin's.
 */
import { activeRemoteAtom, type RendererPlugin } from '@/plugin-api'
import { AGENT_INFO } from '../info'
import { SchedulesSection, schedulesEpochAtom } from './SchedulesSection'
import { AGENT_SERVICE } from './service'
import { agentEvents, agentLeaveGuardAtom, agentVault } from './state/sessions'
import { watchNotices } from './state/notices'

export const agentRenderer: RendererPlugin = {
  info: AGENT_INFO,
  events: {
    ...agentEvents,
    // A schedule ran, or was turned on or off: the section asks again.
    schedules: ({ remote }, store) => {
      if (remote === store.get(activeRemoteAtom)) store.set(schedulesEpochAtom, (n) => n + 1)
    },
  },
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
