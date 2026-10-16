/**
 * The agents' stack of bubbles, floating over the panes' top right on every
 * tab (the plugin's `overlay`), so any agent is one hover away from a note, a
 * board or the agents page itself. Pressing a bubble opens that agent's chat.
 *
 * It is also where a session is stopped, restarted, copied or archived (a
 * bubble's context menu): the statuses and actions live here and nowhere else.
 * **Stop** is `claude stop`: the conversation stays and picks up where it left
 * off. **Archive** takes a chat out of the stack and into the history, from
 * where it comes back; a running one is stopped first, so nothing runs out of
 * sight. An idle session stops at once; one mid-turn, or waiting on an answer,
 * asks first, because that turn is cut short.
 */
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useState } from 'react'
import { surfaceActiveAtom } from '@/plugin-api'
import { Button, Dialog } from '@/primitives'
import { AgentNotices } from './AgentNotices'
import { BubbleStack } from './BubbleStack'
import { sessionsWorthAsking } from '../../agent/renderer/lib/notices'
import { QuickChat } from './QuickChat'
import { agentNoticesAtom, quickChatAtom } from '../../agent/renderer/state/notices'
import {
  archiveSessionAtom,
  duplicateSessionAtom,
  openSessionAtom,
  respawnSessionAtom,
  showHistoryAtom,
  startSessionAtom,
  stopSessionAtom,
} from '../../agent/renderer/state/send'
import {
  AGENT_SURFACE,
  agentArchivedAtom,
  agentStackAtom,
  shownEntryAtom,
  type AgentSession,
} from '../../agent/renderer/state/sessions'

export function AgentBubbles(): React.JSX.Element | null {
  const stack = useAtomValue(agentStackAtom)
  const shown = useAtomValue(shownEntryAtom)
  const openSession = useSetAtom(openSessionAtom)
  const startSession = useSetAtom(startSessionAtom)
  const stopSession = useSetAtom(stopSessionAtom)
  const respawnSession = useSetAtom(respawnSessionAtom)
  const duplicateSession = useSetAtom(duplicateSessionAtom)
  const archive = useSetAtom(archiveSessionAtom)
  const showHistory = useSetAtom(showHistoryAtom)
  const archivedCount = useAtomValue(agentArchivedAtom).length
  const onAgentsPage = useAtomValue(surfaceActiveAtom(AGENT_SURFACE))
  const [quick, setQuick] = useAtom(quickChatAtom)
  const setNotices = useSetAtom(agentNoticesAtom)
  /** A running session about to be stopped, and whether it is then archived. */
  const [confirming, setConfirming] = useState<{
    session: AgentSession
    archiving: boolean
  } | null>(null)

  // Nothing yet to switch between, and nothing to come back to: the agents
  // page offers the first session.
  if (stack.length === 0 && archivedCount === 0) return null

  const live = (id: string): AgentSession | null => {
    const entry = stack.find((e) => e.id === id)
    return entry?.kind === 'live' ? entry.session : null
  }
  const stop = (session: AgentSession, archiving: boolean): void => {
    setConfirming(null)
    void stopSession(session.id).then((res) => {
      if (!res.ok) return console.warn(`[agent] stop ${session.id} failed: ${res.message}`)
      if (archiving) void archive({ id: session.id, archived: true })
    })
  }
  /** Stop, asking first only when something is actually cut short. */
  const requestStop = (id: string, archiving = false): void => {
    const session = live(id)
    if (session === null) return
    if (sessionsWorthAsking([session]).length > 0) setConfirming({ session, archiving })
    else stop(session, archiving)
  }
  /**
   * A face pressed. On the agents page that is the chat shown there. On any
   * other page it is a smaller chat for a message and nothing more, for a
   * session that can take one; one that has finished has only its full page,
   * where it can be picked up. (The words of a row always open the full chat.)
   */
  const face = (id: string): void => {
    if (onAgentsPage || live(id) === null) return void openSession(id)
    setNotices((all) => all.filter((n) => n.sessionId !== id))
    setQuick(id)
  }
  const requestArchive = (id: string): void => {
    if (live(id) !== null) requestStop(id, true)
    else void archive({ id, archived: true })
  }

  return (
    <>
      <BubbleStack
        entries={stack}
        shownId={shown?.id ?? null}
        onPick={(id) => void openSession(id)}
        onFace={face}
        // Off the agents page, a new session opens as the smaller chat.
        onNew={() => void startSession({ quick: !onAgentsPage })}
        // A fresh process for the same conversation: it picks up changed
        // settings and AGENTS.md.
        onRestart={(id) => void respawnSession(id)}
        // A copy in a session of its own: the original keeps running.
        onDuplicate={(id) => void duplicateSession(id)}
        onArchive={requestArchive}
        onStop={(id) => requestStop(id)}
        archivedCount={archivedCount}
        onHistory={() => void showHistory()}
      />
      {/* To the left of the stack, in the top right: the smaller chat a bubble
          opened, and what the agents have to say. */}
      <div
        data-agent-notices=""
        className="pointer-events-none absolute top-4 right-24 z-10 flex w-[22rem] max-w-[calc(100%-8rem)] flex-col gap-2"
      >
        {quick !== null && <QuickChat key={quick} sessionId={quick} />}
        <AgentNotices />
      </div>
      {confirming !== null && (
        <Dialog open onClose={() => setConfirming(null)} size="sm">
          <div className="pointer-events-auto grid min-w-0 gap-4 [&>*]:min-w-0">
            <Dialog.Header>
              {confirming.archiving ? 'Archive' : 'Stop'} {confirming.session.name}?
            </Dialog.Header>
            <Dialog.Body>
              <p className="text-xs text-muted-foreground">
                {confirming.session.state === 'needs-you'
                  ? 'It is waiting for you to answer something, and stopping drops the question.'
                  : 'It is mid-turn, and stopping cuts the turn short. What it has already written stays in the vault.'}{' '}
                {confirming.archiving
                  ? 'It is stopped and put in the history, from where you can bring it back.'
                  : 'The conversation stays and picks up where it left off.'}
              </p>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => stop(confirming.session, confirming.archiving)}
              >
                {confirming.archiving ? 'Stop and archive' : 'Stop session'}
              </Button>
            </Dialog.Footer>
          </div>
        </Dialog>
      )}
    </>
  )
}
