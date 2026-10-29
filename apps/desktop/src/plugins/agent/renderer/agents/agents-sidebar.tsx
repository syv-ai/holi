/**
 * The Agents mode's sidebar (docs/features/agent-sessions.md, The Agents
 * view), top to bottom:
 *
 * - **Inbox**, what needs you, and **History**, every conversation and run,
 *   then the places other plugins add beside them (their slots' `nav`:
 *   Automations).
 * - **Their sections**, by order (Holis).
 * - **Sessions**, with its +: the conversations and runs that are open, as
 *   MonoCode's session cards, what needs you first. One the person starts
 *   is open until they close it; the rest are in History.
 * - What other plugins add after the sessions.
 *
 * After MonoCode's sidebar (MIT, Copyright (c) 2026 Nick; see NOTICE.md).
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { History, Inbox } from 'lucide-react'
import { SidebarMenu } from '@/components/ui/sidebar'
import { agentsSlotsAtom } from '@/plugin-api'
import { SessionList } from '../sessions/session-list'
import { inboxCountAtom } from '../state/agents-status'
import { agentsViewAtom } from '../state/agents-view'
import { SidebarNavItem } from '@/composites/sidebar-nav-item'

/** Where the agent's own sessions sit among the slots' sections. */
const SESSIONS_ORDER = 100

export function AgentsSidebar(): React.JSX.Element {
  const view = useAtomValue(agentsViewAtom)
  const setView = useSetAtom(agentsViewAtom)
  const slots = useAtomValue(agentsSlotsAtom)
  const inbox = useAtomValue(inboxCountAtom)
  const before = slots.filter((s) => (s.order ?? 200) < SESSIONS_ORDER)
  const after = slots.filter((s) => (s.order ?? 200) >= SESSIONS_ORDER)

  return (
    <nav
      aria-label="Agents"
      // Groups spaced by the column's gap, as in Documents: section labels
      // carry no top padding of their own.
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pb-2"
      data-agents-sidebar=""
    >
      {/* The Documents tab's rows: the sidebar's menu, its badge for a count. */}
      <SidebarMenu>
        <SidebarNavItem
          icon={Inbox}
          label="Inbox"
          current={view.kind === 'inbox'}
          count={inbox}
          countLabel="need you"
          onClick={() => setView({ kind: 'inbox' })}
        />
        <SidebarNavItem
          icon={History}
          label="History"
          current={view.kind === 'history'}
          onClick={() => setView({ kind: 'history' })}
        />
        {slots.map((slot) => (slot.nav === undefined ? null : <slot.nav key={slot.plugin} />))}
      </SidebarMenu>

      {before.map((slot) =>
        slot.sidebar === undefined ? null : <slot.sidebar key={slot.plugin} />,
      )}

      <SessionList />

      {after.map((slot) =>
        slot.sidebar === undefined ? null : <slot.sidebar key={slot.plugin} />,
      )}
    </nav>
  )
}
