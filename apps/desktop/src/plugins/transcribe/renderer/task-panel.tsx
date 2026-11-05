/**
 * A task open for editing, in a panel from the right, wide enough for its
 * fields: every word on it is editable, every line it carries finds its line
 * in the transcript, and one not sent yet can be sent to an agent with a note
 * on how the person wants it done: Send to the vault's agent, or to a Holi. The panel
 * leaves the meeting usable beside it: a click on the minutes or the
 * transcript does not close it.
 */
import type { PickableHoli } from '@holi/shared'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { SquareArrowOutUpRight } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { activeRemoteAtom, openPathAtom, showAgentSessionAtom } from '@/plugin-api'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import {
  MAX_CONTEXT,
  type Card,
  type MeetingState,
  type Quote,
  type SendTarget,
} from '../shared/meeting'
import { useAgentName } from './agent-name'
import { CardFields, draftOf, type CardDraft } from './card-fields'
import { clock } from '../shared/scribe-prompt'
import { meetingCap, type CardPatch } from './meeting-cap'
import { SCRIBE_NAME, TASK_NAME } from './names'
import { useRun } from './run-state'
import { SendButton } from './send-button'
import { SpeakerBadge } from './speaker-badge'
import { highlightSegmentAtom, message, openTaskAtom, putCardAtom } from './state'

/** A quote, which finds its words in the transcript when clicked. */
function QuoteButton({ quote, onClick }: { quote: Quote; onClick: () => void }): React.JSX.Element {
  return (
    <Button
      variant="ghost"
      size="row"
      className="w-full items-baseline whitespace-normal"
      onClick={onClick}
    >
      <SpeakerBadge speaker={quote.speaker} />
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {clock(quote.start)}
      </span>
      <span className="text-sm">“{quote.text}”</span>
    </Button>
  )
}

const tidy = (items: readonly string[]): string[] =>
  items.map((x) => x.trim()).filter((x) => x !== '')

/** The fields of `draft` that differ from `card`, as main takes them. */
function patchOf(card: Card, draft: CardDraft): CardPatch {
  const patch: CardPatch = {}
  const title = draft.title.trim()
  if (title !== card.title) patch.title = title
  if (draft.why.trim() !== card.why) patch.why = draft.why.trim()
  const acceptance = tidy(draft.acceptance)
  if (JSON.stringify(acceptance) !== JSON.stringify(card.acceptance)) patch.acceptance = acceptance
  const questions = tidy(draft.openQuestions)
  if (JSON.stringify(questions) !== JSON.stringify(card.openQuestions)) {
    patch.openQuestions = questions
  }
  if (draft.owner.trim() !== (card.owner ?? '')) patch.owner = draft.owner.trim()
  return patch
}

/** One line on what the task is and where it came from. */
function about(card: Card): string {
  const kind = card.kind === 'feature' ? 'Feature' : 'To-do'
  if (card.range !== undefined) {
    return `${kind} from ${clock(card.range.start)} to ${clock(card.range.end)}, ${card.range.lines === 1 ? '1 line' : `${card.range.lines} lines`}`
  }
  return card.origin === 'person' ? `${kind} you made` : `${kind} ${SCRIBE_NAME} suggested`
}

function TaskEditor({
  meeting,
  card,
  holis,
  onClose,
}: {
  meeting: MeetingState
  card: Card
  holis: readonly PickableHoli[]
  onClose: () => void
}): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const agent = useAgentName()
  const put = useSetAtom(putCardAtom)
  const highlight = useSetAtom(highlightSegmentAtom)
  const show = useSetAtom(showAgentSessionAtom)
  const openPath = useSetAtom(openPathAtom)
  const { sent, run } = useRun(card)
  /** The person's edits; null while there are none, so the scribe's changes
   *  show as they come. */
  const [draft, setDraft] = useState<CardDraft | null>(null)
  const [context, setContext] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const live = meeting.phase === 'recording'
  const shown = draft ?? draftOf(card)
  const patch = draft === null ? {} : patchOf(card, draft)
  const dirty = Object.keys(patch).length > 0
  const sentTo =
    card.target?.kind === 'holi'
      ? (holis.find((h) => h.id === (card.target as { id: string }).id)?.name ?? card.target.id)
      : agent

  const act = async (what: string, work: (remote: string) => Promise<void>): Promise<boolean> => {
    if (remote === null) return false
    setBusy(true)
    setError(null)
    try {
      await work(remote)
      return true
    } catch (e) {
      setError(`${what} didn’t work: ${message(e)}`)
      return false
    } finally {
      setBusy(false)
    }
  }
  const change = async (r: string, p: CardPatch) => {
    put(meeting.id, await meetingCap.card(r, { meetingId: meeting.id, cardId: card.id, patch: p }))
  }
  const needsTitle = () => {
    if (shown.title.trim() === '') throw new Error(`a ${TASK_NAME} needs a title`)
  }
  const save = () =>
    act('Saving', async (r) => {
      needsTitle()
      await change(r, patch)
      setDraft(null)
    })
  const send = (target: SendTarget) =>
    act('Sending', async (r) => {
      if (dirty) {
        needsTitle()
        await change(r, patch)
        setDraft(null)
      }
      const note = context.trim()
      const { sessionId } = await meetingCap.build(r, {
        meetingId: meeting.id,
        cardId: card.id,
        ...(note === '' ? {} : { context: note }),
        target,
      })
      put(meeting.id, {
        ...card,
        status: 'building',
        buildSessionId: sessionId,
        target,
        // When it was sent, in the click: Sent until the agent lists its run.
        updatedAt: Date.now(),
      })
      setContext('')
    })
  const dismiss = async () => {
    if (await act('Dismiss', (r) => change(r, { status: 'dismissed' }))) {
      onClose()
      toast(`Dismissed the ${TASK_NAME} “${card.title}”`, {
        action: {
          label: 'Undo',
          onClick: () => void act('Undo', (r) => change(r, { status: 'accepted' })),
        },
      })
    }
  }
  const openSession = () =>
    void show({ session: card.buildSessionId as string, live: run !== undefined })

  return (
    <div className="flex flex-col gap-4">
      {sent && (
        <p className="text-sm text-muted-foreground">
          Sent to {sentTo}
          {card.kind === 'action' ? ' to do or prepare.' : ' to build.'}
        </p>
      )}
      <CardFields draft={shown} live={live} onChange={setDraft} />
      {dirty && (
        <div className="flex gap-2">
          <Button size="sm" disabled={busy} onClick={() => void save()}>
            Save changes
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
            Discard
          </Button>
        </div>
      )}
      {card.quotes.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="text-xs font-medium text-muted-foreground">What was said</h3>
          <ul aria-label="Quotes" className="flex flex-col gap-0.5">
            {card.quotes.map((q) => (
              <li key={q.i}>
                <QuoteButton quote={q} onClick={() => highlight(meeting.id, q.i)} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {!sent && (
        <Textarea
          aria-label="How should it be done?"
          placeholder="How should it be done? Optional"
          maxLength={MAX_CONTEXT}
          value={context}
          onChange={(e) => setContext(e.target.value)}
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!sent && <SendButton holis={holis} busy={busy} onSend={(t) => void send(t)} />}
        {sent && (
          <Button size="sm" variant="secondary" onClick={openSession}>
            <SquareArrowOutUpRight aria-hidden />
            Open session
          </Button>
        )}
        {card.taskPath !== undefined && (
          <Button size="sm" variant="ghost" onClick={() => openPath(card.taskPath as string)}>
            Open task
          </Button>
        )}
        {!sent && (
          <Button
            size="sm"
            variant="ghost"
            className="ms-auto"
            disabled={busy}
            onClick={() => void dismiss()}
          >
            Dismiss
          </Button>
        )}
      </div>
      {error !== null && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

/** The panel, open while a card of `meeting` is the open task. */
export function TaskPanel({
  meeting,
  holis,
}: {
  meeting: MeetingState
  holis: readonly PickableHoli[]
}): React.JSX.Element {
  const [open, setOpen] = useAtom(openTaskAtom)
  const card =
    open?.meetingId === meeting.id ? meeting.cards.find((c) => c.id === open.cardId) : undefined
  return (
    <Sheet modal={false} open={card !== undefined} onOpenChange={(o) => !o && setOpen(null)}>
      {card !== undefined && (
        <SheetContent
          side="right"
          // The stock sheet's own width rule is `data-[side=right]:sm:max-w-sm`;
          // only the same variant outranks it.
          className="data-[side=right]:sm:max-w-xl"
          // Beside the meeting, not over it: the minutes and the transcript
          // stay usable while a task is open.
          onInteractOutside={(e) => e.preventDefault()}
        >
          <SheetHeader>
            <SheetTitle>
              {/* Clear of the close button in the corner. */}
              <span className="block truncate pe-8">{card.title}</span>
            </SheetTitle>
            <SheetDescription>{about(card)}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            <TaskEditor
              key={card.id}
              meeting={meeting}
              card={card}
              holis={holis}
              onClose={() => setOpen(null)}
            />
          </div>
        </SheetContent>
      )}
    </Sheet>
  )
}
