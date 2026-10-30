/**
 * The Agents mode's main view (docs/features/agent-sessions.md, The Agents
 * view): one of five things, picked in the sidebar.
 *
 * - **Home**, what a tab with nothing selected shows: that no session is
 *   open there, and New session. Never the Inbox, which is its own row.
 * - **The Inbox**: the sessions waiting on you, what the agent told you
 *   (`holi agent notify`, needs-you, mentions; docs/features/agent-inbox.md),
 *   and what other plugins add there (a Holi's report that asked for you).
 * - **History**: every conversation and run, open or closed, by day, with
 *   the search and its filter. Opening one puts it back in Sessions.
 * - **A live session**, of any agent: its terminal, filling the view.
 * - **A row another plugin added**: that plugin's own view (its slot).
 *
 * After MonoCode's `SessionPane` (MIT, Copyright (c) 2026 Nick; see
 * NOTICE.md), cut to the mock's simplicity.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Inbox, SquarePen, TerminalSquare } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { IconStackEmpty } from '@/components/ui/icon-stack-empty'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Frame,
  FrameDescription,
  FrameFooter,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from '@/components/ui/frame'
import { Input } from '@/components/ui/input'
import { activeRemoteAtom, agentsSlotsAtom, useNow } from '@/plugin-api'
import { agentCap } from '../agent-cap'
import { SessionTerminal } from '../session-terminal'
import { inboxCountAtom } from '../state/agents-status'
import { inboxAtom } from '../state/inbox'
import { agentsViewAtom, agentsViewOf, viewTerminalsAtom } from '../state/agents-view'
import { newSessionProviderAtom, providerLabel } from '../state/providers'
import { newSessionAtom, sessionRowsAtom } from '../state/session-list'
import { SessionCard } from '../sessions/session-card'
import { SessionSearch } from '../sessions/session-filters'
import { SessionHistory } from '../sessions/session-list'
import { agentGeometryAtom, agentSessionsAtom, type AgentSession } from '../state/sessions'
import { InboxEntries } from './inbox-entries'
import { Skeleton } from '@/components/ui/skeleton'

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
  const rows = useAtomValue(sessionRowsAtom)
  const slots = useAtomValue(agentsSlotsAtom)
  const count = useAtomValue(inboxCountAtom)
  const entries = useAtomValue(inboxAtom).entries.length
  const setView = useSetAtom(agentsViewAtom)
  const create = useSetAtom(newSessionAtom)
  const now = useNow()
  const ids = new Set(sessions.filter((s) => s.state === 'needs-you').map((s) => s.id))
  const waiting = rows.filter((r) => r.item.jobId !== undefined && ids.has(r.item.jobId))
  return (
    <>
      <Bar>
        <span className="font-medium">Inbox</span>
        {count > 0 && <span className="text-muted-foreground tabular-nums">{count}</span>}
      </Bar>
      {count === 0 && entries === 0 ? (
        <IconStackEmpty
          icon={Inbox}
          title="Nothing needs you"
          description="A session waiting on a permission prompt or a question lands here, and so does what an agent asks you to look at, a teammate's mention, and a Holi that asks for you."
          action={{
            label: 'New session',
            icon: SquarePen,
            onClick: () => void create(),
          }}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-6">
            {waiting.length > 0 && (
              <section aria-label="Sessions waiting on you" className="flex flex-col gap-2">
                <h2 className="text-xs font-medium text-muted-foreground">Waiting on you</h2>
                <div className="flex flex-col gap-1">
                  {waiting.map((row) => (
                    <SessionCard
                      key={row.item.key}
                      row={row}
                      now={now}
                      focusable
                      onFocus={() => {}}
                      onOpen={() => setView({ kind: 'session', id: row.item.jobId ?? '' })}
                    />
                  ))}
                </div>
              </section>
            )}
            <InboxEntries />
            {slots.map((slot) =>
              slot.inbox === undefined ? null : <slot.inbox key={slot.plugin} />,
            )}
          </div>
        </div>
      )}
    </>
  )
}

/** Nothing selected: a tab with no session in it (one restored, or the
 *  Agents tab with its session closed). New sessions start straight in their
 *  terminal, so this only offers one. */
function HomeView(): React.JSX.Element {
  const create = useSetAtom(newSessionAtom)
  const provider = useAtomValue(newSessionProviderAtom)
  const setView = useSetAtom(agentsViewAtom)
  return (
    <IconStackEmpty
      icon={TerminalSquare}
      title="No session here"
      description={`Start one and it opens in its terminal, in ${providerLabel(provider)}. Hover the sidebar's + for the other agents.`}
      action={{ label: 'New session', icon: SquarePen, onClick: () => void create() }}
      secondary={{ label: 'History', onClick: () => setView({ kind: 'history' }) }}
    />
  )
}

/** Every conversation and run, under the search that narrows them. */
function HistoryView(): React.JSX.Element {
  return (
    <>
      <Bar>
        <span className="font-medium">History</span>
      </Bar>
      <div className="min-h-0 flex-1 overflow-y-auto" data-agents-history="">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-6">
          <SessionSearch />
          <SessionHistory />
        </div>
      </div>
    </>
  )
}

/** A managed Pi RPC process is not the person's native Pi TUI. Show only
 * status Pi reported, with follow-ups sent to this specific process. */
function PiRunView({ session }: { session: AgentSession }): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const send = async () => {
    if (remote === null || sending || text.trim() === '') return
    setSending(true)
    setError(null)
    try {
      await agentCap.message(remote, { session: session.id, text: text.trim() })
      setText('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }
  const usage = session.usage
  const canMessage = session.outcome !== 'failed' && session.outcome !== 'aborted'
  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto p-6">
      <Frame className="mx-auto w-full max-w-2xl self-start">
        <FrameHeader>
          <FrameTitle>{session.name}</FrameTitle>
          <FrameDescription role="status">
            Pi background run ·{' '}
            {session.state === 'working' ? 'Working' : (session.outcome ?? 'Idle')}
          </FrameDescription>
        </FrameHeader>
        <FramePanel>
          <div className="flex flex-col gap-3 text-sm">
            {session.model && <p>Model: {session.model}</p>}
            {usage?.total !== undefined && <p>Tokens: {usage.total.toLocaleString()}</p>}
            {usage?.cost !== undefined && <p>Cost: ${usage.cost.toFixed(4)}</p>}
            {session.contextPercent !== undefined && <p>Context: {session.contextPercent}%</p>}
            {session.outcome === 'failed' && (
              <Alert variant="destructive">
                <AlertTitle>Pi run failed</AlertTitle>
                <AlertDescription>
                  {session.error ?? 'Pi could not finish this run.'}
                </AlertDescription>
              </Alert>
            )}
            {session.outcome === 'aborted' && <p>Run stopped.</p>}
            {session.state === 'working' && !session.model && <Skeleton className="h-4 w-1/2" />}
          </div>
        </FramePanel>
        {canMessage && (
          <FrameFooter>
            <div className="flex w-full gap-2">
              <Input
                aria-label="Follow up with Pi"
                placeholder="Follow up with Pi"
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void send()
                }}
              />
              <Button
                type="button"
                disabled={sending || text.trim() === ''}
                onClick={() => void send()}
              >
                Send
              </Button>
            </div>
          </FrameFooter>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Could not send</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </Frame>
    </div>
  )
}

/**
 * A live session: its terminal, the whole view, and nothing drawn over it.
 * The agent's own TUI is the interface; what Holi adds is around it (the
 * sidebar row, its menu, the tab). A window of the view's own: the one its
 * New session opened, or a new window onto it that closes with the view (a
 * background session goes on without it; a session Holi runs is its
 * terminal, which stays).
 */
function SessionView({ id }: { id: string }): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const geometry = useAtomValue(agentGeometryAtom)
  const setGeometry = useSetAtom(agentGeometryAtom)
  const owned = useAtomValue(viewTerminalsAtom)[id]
  const setOwned = useSetAtom(viewTerminalsAtom)
  const [terminalId, setTerminalId] = useState<string | null>(owned ?? null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const opened = useRef<string | null>(owned ?? null)

  useEffect(() => {
    if (remote === null) return
    let gone = false
    if (opened.current === null) {
      void agentCap.open(remote, { attach: id, ...geometry }).then((res) => {
        if (gone) {
          if (res.ok) void agentCap.detach(remote, { id: res.terminalId })
          return
        }
        if (res.ok) {
          opened.current = res.terminalId
          setTerminalId(res.terminalId)
          setError(null)
        } else setError(res.message)
      })
    }
    return () => {
      gone = true
      // The window closes with the view. Main keeps a session's own
      // terminal open: only a window onto a background session ends.
      if (opened.current !== null) void agentCap.detach(remote, { id: opened.current })
      opened.current = null
      setOwned((t) => {
        const { [id]: _gone, ...rest } = t
        return rest
      })
    }
    // Opened once per session shown (and per Retry); the geometry is only
    // where it starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote, id, attempt])

  if (error !== null) {
    return (
      <IconStackEmpty
        icon={TerminalSquare}
        title="Couldn't open its terminal"
        description={error}
        role="alert"
        action={{
          label: 'Retry',
          onClick: () => {
            setError(null)
            setAttempt((n) => n + 1)
          },
        }}
      />
    )
  }
  if (terminalId === null) {
    return (
      <div
        className="flex flex-1 flex-col gap-2 p-6"
        role="status"
        aria-label="Opening the terminal"
      >
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    )
  }
  return (
    // Keyed by the terminal: an xterm is bound to the terminal it was built
    // for, so a window opened again (a Retry, or React's dev remount, which
    // closes the first) gets an xterm of its own rather than a blank one.
    <SessionTerminal
      key={terminalId}
      terminalId={terminalId}
      visible
      onGeometry={(cols, rows) => setGeometry({ cols, rows })}
    />
  )
}

/** One tab's view: `selection` is what the tab shows (null, the home), so
 *  two panes can show two sessions; the sidebar's selection is the focused
 *  tab's, which the shell keeps in step. */
export function AgentsView({
  selection,
}: {
  selection: { owner: string; id: string } | null
}): React.JSX.Element {
  const view = agentsViewOf(selection)
  const sessions = useAtomValue(agentSessionsAtom)
  const slots = useAtomValue(agentsSlotsAtom)
  const slot = view.kind === 'slot' ? slots.find((s) => s.plugin === view.owner) : undefined
  // A plugin may draw the home; the agent's own says nothing is open.
  const Home = slots.find((s) => s.home !== undefined)?.home ?? HomeView

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
        sessions.find((s) => s.id === view.id)?.provider === 'pi' && view.id.length === 8 ? (
          <PiRunView key={view.id} session={sessions.find((s) => s.id === view.id)!} />
        ) : (
          <SessionView key={view.id} id={view.id} />
        )
      ) : view.kind === 'slot' && slot?.main !== undefined ? (
        <slot.main key={view.id} id={view.id} />
      ) : view.kind === 'inbox' ? (
        <InboxView />
      ) : view.kind === 'history' ? (
        <HistoryView />
      ) : (
        <Home />
      )}
    </div>
  )
}
