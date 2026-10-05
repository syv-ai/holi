/**
 * The agents page (docs/features/agent-sessions.md): one session's chat, or
 * the history of the archived ones (`AgentHistory`). Which
 * session, and how each is doing, is the stack of bubbles floating over the
 * top right (`AgentBubbles`), here as on every other tab; this page has no
 * header of its own. It opens on the most recent session. Only chats are drawn
 * here: the terminal Claude Code runs in is behind the chat, and shows only
 * when a dialog needs it (`ChatView`).
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Button } from '@/primitives'
import { AgentFace } from './AgentFace'
import { AgentHistory } from './AgentHistory'
import { ChatView } from './chat/ChatView'
import { startSessionAtom } from '../../agent/renderer/state/send'
import {
  agentViewAtom,
  shownEntryAtom,
  type AgentSession,
  type StackEntry,
} from '../../agent/renderer/state/sessions'
import { TurnChip } from './TurnChip'

/** A past session read as a session that is idle, which is what its chat wants. */
function asSession(entry: StackEntry): AgentSession {
  return entry.kind === 'live'
    ? entry.session
    : { id: entry.id, name: entry.name, state: 'idle', phase: entry.session.phase }
}

export function AgentOverview({ visible }: { visible: boolean }): React.JSX.Element {
  const shown = useAtomValue(shownEntryAtom)
  const view = useAtomValue(agentViewAtom)
  const startSession = useSetAtom(startSessionAtom)

  return (
    <div className="flex min-h-0 flex-1 justify-center overflow-hidden" data-agent-overview="">
      {/* Room on the right for the bubbles, which rest over the corner. */}
      <div className="flex min-h-0 w-full max-w-4xl flex-col pr-16">
        {view === 'history' ? (
          <AgentHistory />
        ) : shown === null ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
            <AgentFace seed="" state="off" size="lg" />
            <p className="text-sm text-muted-foreground">No agent has run here yet.</p>
            <Button variant="outline" size="sm" onClick={() => void startSession()}>
              Start a session
            </Button>
          </div>
        ) : (
          <>
            {/* Keyed by session, so one chat's scroll and transcript are not
                another's; a finished session picked up stays the same chat. */}
            <ChatView
              key={shown.id}
              session={asSession(shown)}
              past={shown.kind === 'past'}
              visible={visible}
            />
            <div className="shrink-0 px-4 pb-2 empty:hidden">
              <TurnChip key={shown.id} sessionId={shown.id} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
