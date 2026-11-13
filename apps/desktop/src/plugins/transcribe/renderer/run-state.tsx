/**
 * Where a sent card's run is, from the agent's live sessions: running, needs
 * you, sent and waiting, or done once its session has left the list. A card
 * sent this last minute whose session the list has not caught up with yet is
 * Sent, not Done.
 */
import { useAtomValue } from 'jotai'
import { agentSessionRowsAtom, useNow, type AgentSessionRow } from '@/plugin-api'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import type { Card } from '../shared/meeting'

/** A sent card's run, from the agent's live sessions. */
export function useRun(card: Card | undefined) {
  const sessions = useAtomValue(agentSessionRowsAtom)
  const sent = card?.status === 'building' && card.buildSessionId !== undefined
  return { sent, run: sent ? sessions.find((s) => s.id === card.buildSessionId) : undefined }
}

/** How long a session the list has not named yet counts as just sent. */
const JUST_SENT_MS = 60_000

export function RunState({
  row,
  sentAt,
}: {
  row: AgentSessionRow | undefined
  /** When the card was last changed, epoch ms: its send, or later. */
  sentAt: number
}): React.JSX.Element {
  const now = useNow(5000)
  if (row === undefined) {
    return now - sentAt < JUST_SENT_MS ? (
      <Badge variant="secondary">Sent</Badge>
    ) : (
      <Badge variant="success">Done</Badge>
    )
  }
  if (row.state === 'needs-you') return <Badge variant="warning">Needs you</Badge>
  if (row.state === 'working') {
    return (
      <Badge variant="info">
        <Spinner />
        Running
      </Badge>
    )
  }
  return <Badge variant="secondary">Sent</Badge>
}
