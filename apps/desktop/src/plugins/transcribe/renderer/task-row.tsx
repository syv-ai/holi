/**
 * One task as one row: a feature to build or a to-do, its title, and where it
 * stands (not sent yet, or its run's state). A click opens it in the task
 * panel (`task-panel.tsx`), where its words are editable and it is sent; a
 * sent one opens its session from the row too.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Hammer, ListTodo, SquareArrowOutUpRight } from 'lucide-react'
import { showAgentSessionAtom } from '@/plugin-api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/composites/icon-button'
import type { CardKind, MeetingState, Card } from '../shared/meeting'
import { RunState, useRun } from './run-state'
import { openTaskAtom } from './state'

/** What kind a task or suggestion is, as an icon named for it. */
export function KindIcon({ kind }: { kind: CardKind }): React.JSX.Element {
  return kind === 'feature' ? (
    <Hammer aria-label="Feature" className="icon-sm shrink-0 text-muted-foreground" />
  ) : (
    <ListTodo aria-label="To-do" className="icon-sm shrink-0 text-muted-foreground" />
  )
}

/** Open session, for a sent card. */
export function OpenSession({ card }: { card: Card }): React.JSX.Element | null {
  const show = useSetAtom(showAgentSessionAtom)
  const { sent, run } = useRun(card)
  if (!sent) return null
  return (
    <IconButton
      label="Open session"
      size="icon-xs"
      onClick={() => void show({ session: card.buildSessionId as string, live: run !== undefined })}
    >
      <SquareArrowOutUpRight aria-hidden />
    </IconButton>
  )
}

export function TaskRow({
  meeting,
  card,
}: {
  meeting: MeetingState
  card: Card
}): React.JSX.Element {
  const open = useAtomValue(openTaskAtom)
  const setOpen = useSetAtom(openTaskAtom)
  const { sent, run } = useRun(card)
  const isOpen = open?.meetingId === meeting.id && open.cardId === card.id

  return (
    <div
      role="group"
      aria-label={card.title}
      data-card={card.id}
      className="flex items-center gap-1"
    >
      <Button
        variant="ghost"
        size="row"
        className="min-w-0 flex-1"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onClick={() => setOpen(isOpen ? null : { meetingId: meeting.id, cardId: card.id })}
      >
        <KindIcon kind={card.kind} />
        <span className="min-w-0 flex-1 truncate text-sm">{card.title}</span>
        {sent ? (
          <RunState row={run} sentAt={card.updatedAt} />
        ) : (
          <Badge variant="secondary">Not sent</Badge>
        )}
      </Button>
      <OpenSession card={card} />
    </div>
  )
}
