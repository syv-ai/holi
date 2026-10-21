/**
 * The Agents mode's sidebar (docs/features/agent-sessions.md, The Agents
 * view), top to bottom:
 *
 * - **Inbox**, what needs you, then the places other plugins add beside it
 *   (their slots' `nav`: Automations).
 * - **Their sections**, by order (Holis).
 * - **Sessions**, with its +: the live background sessions as MonoCode's
 *   session cards, waiting on you first, then working, then idle, and a
 *   search over their names once there are some.
 * - What other plugins add after the sessions (chat).
 *
 * After MonoCode's sidebar (MIT, Copyright (c) 2026 Nick; see NOTICE.md).
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Inbox, Plus, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { EmptyState, SectionLabel } from '@/composites'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  Icon,
  IconButton,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Kbd,
} from '@/primitives'
import { activeRemoteAtom, agentsSlotsAtom } from '@/plugin-api'
import { inboxCountAtom } from '../state/agents-status'
import { agentsViewAtom } from '../state/agents-view'
import { agentSessionsAtom, type AgentSession } from '../state/sessions'
import { duplicateSessionAtom, respawnSessionAtom, stopSessionAtom } from '../state/send'
import { newViewSessionAtom } from '../state/session-view'
import { NavRow, SessionCard } from './parts'

/** Where the agent's own sessions sit among the slots' sections. */
const SESSIONS_ORDER = 100

/** Waiting on you first, then working, then idle; newest first within each. */
const RANK = { 'needs-you': 0, working: 1, idle: 2 } as const

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

/** A live background session, shown in its terminal. */
function SessionRow({
  session,
  vault,
  now,
}: {
  session: AgentSession
  vault: string
  now: number
}): React.JSX.Element {
  const view = useAtomValue(agentsViewAtom)
  const setView = useSetAtom(agentsViewAtom)
  const stop = useSetAtom(stopSessionAtom)
  const respawn = useSetAtom(respawnSessionAtom)
  const duplicate = useSetAtom(duplicateSessionAtom)
  const current = view.kind === 'session' && view.id === session.id
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <SessionCard
          session={session}
          vault={vault}
          current={current}
          now={now}
          onClick={() => setView({ kind: 'session', id: session.id })}
        />
      </ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
        <ContextMenuItem onSelect={() => void respawn(session.id)}>Restart</ContextMenuItem>
        <ContextMenuItem onSelect={() => void duplicate(session.id)}>Duplicate</ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={() => void stop(session.id)}>
          Stop session
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function Sessions(): React.JSX.Element {
  const all = useAtomValue(agentSessionsAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const newSession = useSetAtom(newViewSessionAtom)
  const [query, setQuery] = useState('')
  const now = useNow()
  const vault = remote ?? ''

  const sessions = useMemo(() => {
    const q = query.trim().toLowerCase()
    return all
      .filter((s) => q === '' || s.name.toLowerCase().includes(q))
      .map((s, i) => ({ s, i }))
      .sort(
        (a, b) =>
          RANK[a.s.state] - RANK[b.s.state] ||
          (b.s.startedAt ?? 0) - (a.s.startedAt ?? 0) ||
          a.i - b.i,
      )
      .map(({ s }) => s)
  }, [all, query])

  return (
    <section aria-label="Sessions" className="flex min-h-0 flex-1 flex-col gap-1">
      <div className="flex items-center justify-between pe-1">
        <SectionLabel className="flex items-center gap-1.5 pb-0">
          Sessions
          {all.length > 0 && (
            <span className="tabular-nums text-muted-foreground">{all.length}</span>
          )}
        </SectionLabel>
        <IconButton
          icon={Plus}
          label="New session"
          tooltip={
            <span className="flex items-center gap-2">
              New session <Kbd>⌘N</Kbd>
            </span>
          }
          size="sm"
          onClick={() => void newSession()}
        />
      </div>
      {all.length === 0 ? (
        <EmptyState
          className="flex-none px-2 py-6"
          title="No sessions running"
          description="Start one and it runs in the background, here, while you work on your notes."
          action={{ label: 'New session', icon: Plus, onClick: () => void newSession() }}
        />
      ) : (
        <>
          <InputGroup>
            <InputGroupAddon>
              <Icon icon={Search} size="sm" tone="muted" />
            </InputGroupAddon>
            <InputGroupInput
              placeholder="Search sessions…"
              aria-label="Search sessions"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('')
              }}
            />
          </InputGroup>
          <div className="flex flex-col gap-0.5">
            {sessions.length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">No sessions match.</p>
            ) : (
              sessions.map((s) => <SessionRow key={s.id} session={s} vault={vault} now={now} />)
            )}
          </div>
        </>
      )}
    </section>
  )
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

      <Sessions />

      {after.map((slot) =>
        slot.sidebar === undefined ? null : <slot.sidebar key={slot.plugin} />,
      )}
    </nav>
  )
}
