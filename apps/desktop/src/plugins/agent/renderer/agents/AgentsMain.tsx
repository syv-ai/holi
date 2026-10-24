/**
 * The Agents mode's main view (docs/features/agent-sessions.md, The Agents
 * view): one of four things, picked in the sidebar.
 *
 * - **Home**, what the view opens on whenever nothing is selected: the
 *   new-session page, the built-in chat's `home`. Never the Inbox, which is
 *   its own row.
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
import { useState } from 'react'
import { IconStackEmpty } from '@/components/reui/icon-stack-empty'
import { Button } from '@/components/ui/button'
import { activeRemoteAtom, agentsSlotsAtom } from '@/plugin-api'
import { inboxCountAtom } from '../state/agents-status'
import { agentsViewAtom, agentsViewOf } from '../state/agents-view'
import { stopSessionAtom } from '../state/send'
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
  const now = useNow()
  const waiting = sessions.filter((s) => s.state === 'needs-you')
  return (
    <>
      <Bar>
        <span className="font-medium">Inbox</span>
        {count > 0 && <span className="text-muted-foreground tabular-nums">{count}</span>}
      </Bar>
      {count === 0 ? (
        <IconStackEmpty
          icon={Inbox}
          title="Nothing needs you"
          description="A session waiting on a permission prompt or a question lands here, and so does a Holi that asks for you."
          action={{
            label: 'New session',
            icon: SquarePen,
            onClick: () => setView({ kind: 'home' }),
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

/**
 * A background run (a Holi's, an automation's, one the agent started): what
 * it is, where it stands, its model and since when, and Stop; under that its
 * conversation, read only, once Claude Code has said which it is: the slot's
 * `conversation` (the built-in chat's transcript, read from Claude Code's own
 * file). Without one it is a summary. Nothing here answers its prompts, and
 * there is no "Continue in chat": a background job is not a chat's process.
 * What it changes reaches the vault and its turn review.
 */
function SessionView({ id }: { id: string }): React.JSX.Element {
  const sessions = useAtomValue(agentSessionsAtom)
  const stop = useSetAtom(stopSessionAtom)
  const slots = useAtomValue(agentsSlotsAtom)
  const [error, setError] = useState<string | null>(null)
  const session = sessions.find((s) => s.id === id)
  const Conversation = slots.find((s) => s.conversation !== undefined)?.conversation
  const facts = [
    session?.model,
    session?.startedAt === undefined
      ? undefined
      : `started ${new Date(session.startedAt).toLocaleTimeString(undefined, {
          hour: 'numeric',
          minute: '2-digit',
        })}`,
  ].filter((f): f is string => f !== undefined)
  const description =
    session?.state === 'needs-you'
      ? `It waits on ${session.waitingFor ?? 'you'}: a prompt in its own terminal, which this view does not show yet. Stop it, or let it time out.`
      : session?.state === 'working'
        ? 'A Holi, an automation or the agent started it. It works on its own; what it changes reaches the vault and its turn review.'
        : 'It has finished its work for now. What it changed is in the vault and its turn review.'
  const reading = Conversation !== undefined && session?.conversationId !== undefined
  return (
    <>
      <Bar
        end={
          reading ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => void stop(id).then((res) => setError(res.ok ? null : res.message))}
            >
              Stop session
            </Button>
          ) : undefined
        }
      >
        <span className="truncate font-medium">{session?.name ?? 'Session'}</span>
        {session !== undefined && (
          <span className="flex shrink-0 items-center gap-2 text-xs">
            <StateLabel state={session.state} />
          </span>
        )}
        {facts.length > 0 && (
          <span className="truncate text-xs text-muted-foreground">{facts.join(' · ')}</span>
        )}
      </Bar>
      {Conversation !== undefined && session?.conversationId !== undefined ? (
        <>
          {error !== null || session.state === 'needs-you' ? (
            <p role="alert" className="px-6 pt-3 text-xs text-muted-foreground">
              {error ?? description}
            </p>
          ) : null}
          <Conversation
            conversationId={session.conversationId}
            live={session.state !== 'idle'}
            title={session.name}
          />
        </>
      ) : (
        <IconStackEmpty
          icon={Bot}
          title="A background run"
          description={error ?? description}
          role={error === null ? undefined : 'alert'}
          action={{
            label: 'Stop session',
            onClick: () => void stop(id).then((res) => setError(res.ok ? null : res.message)),
          }}
        />
      )}
    </>
  )
}

/** One tab's view: `selection` is what the tab shows (null, the home), so
 *  two panes can show two sessions; the sidebar's selection is the focused
 *  tab's, which the shell keeps in step. */
export function AgentsMain({
  selection,
}: {
  selection: { owner: string; id: string } | null
}): React.JSX.Element {
  const view = agentsViewOf(selection)
  const sessions = useAtomValue(agentSessionsAtom)
  const slots = useAtomValue(agentsSlotsAtom)
  const slot = view.kind === 'slot' ? slots.find((s) => s.plugin === view.owner) : undefined
  const Home = slots.find((s) => s.home !== undefined)?.home

  // A session that stopped, or a plugin turned off, is no longer something to
  // show: its tab shows the home until it is closed.
  const missing =
    (view.kind === 'session' && !sessions.some((s) => s.id === view.id)) ||
    (view.kind === 'slot' && slot?.main === undefined)

  return (
    // No ground of its own: on macOS the window is glass, and the shell's
    // `main` tints it as the vault's Transparency asks (index.css, Glass).
    <div className="flex min-h-0 flex-1 flex-col" data-agents-main={view.kind}>
      {view.kind === 'session' && !missing ? (
        <SessionView key={view.id} id={view.id} />
      ) : view.kind === 'slot' && slot?.main !== undefined ? (
        <slot.main key={view.id} id={view.id} />
      ) : view.kind === 'inbox' ? (
        <InboxView />
      ) : Home !== undefined ? (
        <Home />
      ) : null}
    </div>
  )
}
