/**
 * The Agents mode's main view (docs/features/agent-sessions.md, The Agents
 * view): one of four things, picked in the sidebar.
 *
 * - **Home**, what the view opens on: a slot's `home` when one offers it
 *   (the chat plugin's new-session page), else the Inbox.
 * - **The Inbox**: the sessions waiting on you, and what other plugins add
 *   there (a Holi's report that asked for you).
 * - **A background session**: what it is and its state. Its terminal is not
 *   drawn here while conversations are the session UI (docs/features/chat.md);
 *   the session runs on, and Holis and automations keep starting them.
 * - **A row another plugin added**: that plugin's own view (its slot).
 *
 * After MonoCode's `SessionPane` (MIT, Copyright (c) 2026 Nick; see
 * NOTICE.md), cut to the mock's simplicity.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Bot, Inbox, SquarePen } from 'lucide-react'
import { useEffect, useState } from 'react'
import { EmptyState } from '@/composites'
import { activeRemoteAtom, agentsSlotsAtom } from '@/plugin-api'
import { inboxCountAtom } from '../state/agents-status'
import { agentsViewAtom } from '../state/agents-view'
import { newViewSessionAtom } from '../state/session-view'
import { agentSessionsAtom } from '../state/sessions'
import { SessionCard, StateLabel } from './parts'
import { useNow } from './AgentsSidebar'

function Bar({
  children,
  end,
}: {
  children: React.ReactNode
  end?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-divider pe-3 ps-4 text-sm">
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      {end !== undefined && <div className="flex shrink-0 items-center gap-0.5">{end}</div>}
    </div>
  )
}

/** What needs the person, in one column: the sessions waiting on a prompt or
 *  a question, then what each plugin adds. Empty, it says what lands here. */
function InboxView(): React.JSX.Element {
  const sessions = useAtomValue(agentSessionsAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const slots = useAtomValue(agentsSlotsAtom)
  const count = useAtomValue(inboxCountAtom)
  const setView = useSetAtom(agentsViewAtom)
  const start = useSetAtom(newViewSessionAtom)
  const [error, setError] = useState<string | null>(null)
  const now = useNow()
  const waiting = sessions.filter((s) => s.state === 'needs-you')
  return (
    <>
      <Bar>
        <span className="font-medium">Inbox</span>
        {count > 0 && <span className="text-muted-foreground tabular-nums">{count}</span>}
      </Bar>
      {count === 0 ? (
        <EmptyState
          icon={Inbox}
          title="Nothing needs you"
          description={
            error ??
            'A session waiting on a permission prompt or a question lands here, and so does a Holi that asks for you.'
          }
          action={{
            label: 'New session',
            icon: SquarePen,
            onClick: () => void start().then((res) => setError(res.ok ? null : res.message)),
          }}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-6">
            {waiting.length > 0 && (
              <section aria-label="Sessions waiting on you" className="flex flex-col gap-2">
                <h2 className="text-xs font-medium text-muted-foreground">Waiting on you</h2>
                <div className="flex flex-col gap-1">
                  {waiting.map((s) => (
                    <SessionCard
                      key={s.id}
                      session={s}
                      vault={remote ?? ''}
                      current={false}
                      now={now}
                      onClick={() => setView({ kind: 'session', id: s.id })}
                    />
                  ))}
                </div>
              </section>
            )}
            {slots.map((slot) =>
              slot.inbox === undefined ? null : <slot.inbox key={slot.plugin} />,
            )}
          </div>
        </div>
      )}
    </>
  )
}

/** A background session, without its terminal: what it is and where it
 *  stands. Holis and automations run sessions like this one. */
function SessionView({ id }: { id: string }): React.JSX.Element {
  const sessions = useAtomValue(agentSessionsAtom)
  const session = sessions.find((s) => s.id === id)
  return (
    <>
      <Bar>
        <span className="truncate font-medium">{session?.name ?? 'Session'}</span>
        {session !== undefined && (
          <span className="flex shrink-0 items-center gap-2 text-xs">
            <StateLabel state={session.state} />
          </span>
        )}
      </Bar>
      <EmptyState
        icon={Bot}
        title="Running in the background"
        description="This session was started by a Holi or an automation. It works on its own; what it changes shows up in the vault and in its turn review."
      />
    </>
  )
}

export function AgentsMain(): React.JSX.Element {
  const view = useAtomValue(agentsViewAtom)
  const setView = useSetAtom(agentsViewAtom)
  const sessions = useAtomValue(agentSessionsAtom)
  const slots = useAtomValue(agentsSlotsAtom)
  const slot = view.kind === 'slot' ? slots.find((s) => s.plugin === view.owner) : undefined
  const Home = slots.find((s) => s.home !== undefined)?.home

  // A session that stopped, or a plugin turned off, is no longer something to
  // show.
  const missing =
    (view.kind === 'session' && !sessions.some((s) => s.id === view.id)) ||
    (view.kind === 'slot' && slot?.main === undefined)
  useEffect(() => {
    if (missing) setView({ kind: 'home' })
  }, [missing, setView])

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-agents-main={view.kind}>
      {view.kind === 'session' && !missing ? (
        <SessionView key={view.id} id={view.id} />
      ) : view.kind === 'slot' && slot?.main !== undefined ? (
        <slot.main key={view.id} id={view.id} />
      ) : view.kind === 'home' && Home !== undefined ? (
        <Home />
      ) : (
        <InboxView />
      )}
    </div>
  )
}
