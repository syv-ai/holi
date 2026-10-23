/**
 * The Agents mode's sidebar (docs/features/agent-sessions.md, The Agents
 * view), top to bottom:
 *
 * - **Search conversations…**, with its filter menu, over the sessions.
 * - **Inbox**, what needs you, then the places other plugins add beside it
 *   (their slots' `nav`: Automations).
 * - **Their sections**, by order (Holis).
 * - **Sessions**, with its +: one list of every conversation and run, the
 *   agent's live sessions and what the slots add (chats, a Holi's runs, an
 *   automation's), as MonoCode's session cards, what needs you pinned first.
 * - What other plugins add after the sessions.
 *
 * After MonoCode's sidebar (MIT, Copyright (c) 2026 Nick; see NOTICE.md).
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Inbox } from 'lucide-react'
import { useEffect, useState } from 'react'
import { agentsSlotsAtom } from '@/plugin-api'
import { SessionList, SessionSearch } from '../sessions/SessionList'
import { inboxCountAtom } from '../state/agents-status'
import { agentsViewAtom } from '../state/agents-view'
import { NavRow } from './parts'

/** Where the agent's own sessions sit among the slots' sections. */
const SESSIONS_ORDER = 100

/** "now" that moves, so the cards' times stay true.
 *  Reading the wall clock is the point: an age ("5m") counts from it. */
export function useNow(stepMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), stepMs)
    return () => window.clearInterval(id)
  }, [stepMs])
  return now
}

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
      <SessionSearch />

      <div className="flex flex-col gap-0.5">
        <NavRow
          icon={Inbox}
          label="Inbox"
          current={view.kind === 'inbox' || view.kind === 'home'}
          onClick={() => setView({ kind: 'inbox' })}
          end={
            inbox > 0 ? (
              <span className="text-xs tabular-nums text-amber-600 dark:text-amber-400">
                {inbox}
              </span>
            ) : undefined
          }
        />
        {slots.map((slot) => (slot.nav === undefined ? null : <slot.nav key={slot.plugin} />))}
      </div>

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
