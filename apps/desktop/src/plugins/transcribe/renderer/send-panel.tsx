/**
 * Send a topic, or one of the scribe's suggestions in it, to an agent: the main
 * action of the Meetings tab. A panel from the right shows the topic's title
 * and summary, asks what should be done (prefilled from a suggestion),
 * whether it is a feature or a to-do, and offers what else in the meeting
 * the ask is about: the five best-matching stretches outside the topic
 * (`meeting.related`, BM25), each unticked until the person ticks it,
 * re-asked as they type. Send makes the task with the topic's lines (and a
 * suggestion's), plus the ticked ones (`meeting.task.create`), and sends it
 * to the vault's agent or a Holi (`meeting.build`), so the brief carries every one of
 * those lines. Like the task panel it leaves the meeting usable beside it.
 */
import type { PickableHoli } from '@holi/shared'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useId, useState } from 'react'
import { toast } from 'sonner'
import { activeRemoteAtom } from '@/plugin-api'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldLabel, FieldTitle } from '@/components/ui/field'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { Related } from '../main/related'
import { asOne } from '../shared/joins'
import {
  MAX_PROMPT,
  type Card,
  type CardKind,
  type MeetingState,
  type SendTarget,
  type Suggestion,
  type Topic,
} from '../shared/meeting'
import { useAgentName } from './agent-name'
import { clock } from '../shared/scribe-prompt'
import { meetingCap } from './meeting-cap'
import { SendButton } from './send-button'
import { message, putCardAtom, sendPanelAtom } from './state'
import { topicName } from './topic-index'

/** How long typing rests before the related lines are asked again. */
const RELATED_DEBOUNCE_MS = 300

const keyOf = (r: Related): number => r.lines[0]!

type RelatedState =
  { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'done'; windows: Related[] }

/** The related stretches for `query`, asked again as it changes, after a rest. */
function useRelated(meetingId: string, query: string, exclude: readonly number[]) {
  const remote = useAtomValue(activeRemoteAtom)
  const [state, setState] = useState<RelatedState>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const excluded = exclude.join(',')
  useEffect(() => {
    if (remote === null) return
    let live = true
    setState((s) => (s.kind === 'done' ? s : { kind: 'loading' }))
    const timer = setTimeout(() => {
      meetingCap
        .related(remote, {
          meetingId,
          query,
          exclude: excluded === '' ? [] : excluded.split(',').map(Number),
        })
        .then((windows) => live && setState({ kind: 'done', windows }))
        .catch((e: unknown) => live && setState({ kind: 'error', message: message(e) }))
    }, RELATED_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [remote, meetingId, query, excluded, attempt])
  return { state, retry: () => setAttempt((n) => n + 1) }
}

function RelatedRow({
  window: w,
  checked,
  onChange,
}: {
  window: Related
  checked: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  const id = useId()
  return (
    <li className="flex min-w-0 items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      <label htmlFor={id} className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {clock(w.start)}
        </span>
        <span className="min-w-0 truncate text-sm">{w.text}</span>
      </label>
    </li>
  )
}

function SendForm({
  meeting,
  topic,
  suggestion,
  holis,
  onDone,
}: {
  meeting: MeetingState
  topic: Topic
  suggestion: Suggestion | undefined
  holis: readonly PickableHoli[]
  onDone: () => void
}): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const put = useSetAtom(putCardAtom)
  const agent = useAgentName()
  const promptId = useId()
  const [prompt, setPrompt] = useState(() =>
    suggestion === undefined ? '' : `${suggestion.title}\n${suggestion.why}`.trim(),
  )
  const [kind, setKind] = useState<CardKind>(suggestion?.kind ?? 'feature')
  /** The related stretches ticked, kept while the list changes under them. */
  const [picked, setPicked] = useState<Related[]>([])
  /** The task made, when sending it failed after: a retry remakes it from
   *  the form. */
  const [made, setMade] = useState<Card | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const query = [prompt, topic.title, ...topic.keywords].join(' ')
  const related = useRelated(meeting.id, query, topic.lines)
  const found = related.state.kind === 'done' ? related.state.windows : []
  const shown = [...picked, ...found.filter((w) => !picked.some((p) => keyOf(p) === keyOf(w)))]
  const canSend = !busy && prompt.trim() !== '' && remote !== null

  const tick = (w: Related, on: boolean) =>
    setPicked((all) => (on ? [...all, w] : all.filter((p) => keyOf(p) !== keyOf(w))))

  const send = async (target: SendTarget) => {
    if (!canSend) return
    setBusy(true)
    setError(null)
    try {
      const lines = [
        ...new Set([
          ...(suggestion?.segments ?? []),
          ...topic.lines,
          ...picked.flatMap((w) => w.lines),
        ]),
      ].sort((a, b) => a - b)
      // A retry after a send that failed makes the task again from the form
      // as it is now, in place of the one made then.
      const card = await meetingCap['task.create'](remote, {
        meetingId: meeting.id,
        lines,
        prompt: prompt.trim(),
        kind,
        from: {
          topicId: topic.id,
          ...(suggestion === undefined ? {} : { suggestionId: suggestion.id }),
        },
        ...(made === null ? {} : { cardId: made.id }),
      })
      setMade(card)
      put(meeting.id, card)
      const sent = await meetingCap.build(remote, {
        meetingId: meeting.id,
        cardId: card.id,
        target,
      })
      // Main's card, not one made here: it has the task.
      put(meeting.id, sent.card)
      const to =
        target.kind === 'holi' ? (holis.find((h) => h.id === target.id)?.name ?? target.id) : agent
      toast(`Sent “${card.title}” to ${to}`)
      onDone()
    } catch (e) {
      setError(`Sending didn’t work: ${message(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {topic.summary.length > 0 && (
        <ul aria-label="Summary" className="flex list-disc flex-col gap-0.5 ps-5 text-sm">
          {topic.summary.map((b, k) => (
            <li key={k}>{b}</li>
          ))}
        </ul>
      )}
      <Field>
        <FieldLabel htmlFor={promptId}>What should be done?</FieldLabel>
        <Textarea
          id={promptId}
          placeholder="e.g. Turn this into a spec for the CI change"
          maxLength={MAX_PROMPT}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </Field>
      <Field>
        <FieldTitle>Kind</FieldTitle>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          aria-label="Kind"
          value={kind}
          onValueChange={(v) => v !== '' && setKind(v as CardKind)}
        >
          <ToggleGroupItem value="feature">Feature</ToggleGroupItem>
          <ToggleGroupItem value="action">To-do</ToggleGroupItem>
        </ToggleGroup>
      </Field>
      <section aria-label="Related from elsewhere in the meeting" className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">
          Related from elsewhere in the meeting
        </h3>
        {related.state.kind === 'error' ? (
          <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
            <span>The related lines didn’t load: {related.state.message}</span>
            <Button size="xs" variant="ghost" onClick={related.retry}>
              Retry
            </Button>
          </div>
        ) : related.state.kind === 'loading' && picked.length === 0 ? (
          <div role="status" aria-label="Finding related lines" className="flex flex-col gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        ) : shown.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing else in the meeting matches yet. Say more about what should be done.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {shown.map((w) => (
              <RelatedRow
                key={keyOf(w)}
                window={w}
                checked={picked.some((p) => keyOf(p) === keyOf(w))}
                onChange={(on) => tick(w, on)}
              />
            ))}
          </ul>
        )}
      </section>
      <div className="flex items-center gap-2">
        <SendButton holis={holis} busy={!canSend} onSend={(t) => void send(t)} />
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {error !== null && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

/** The panel, open while a topic of `meeting` is being sent. */
export function SendPanel({
  meeting,
  holis,
}: {
  meeting: MeetingState
  holis: readonly PickableHoli[]
}): React.JSX.Element {
  const [open, setOpen] = useAtom(sendPanelAtom)
  const found =
    open?.meetingId === meeting.id ? meeting.topics.find((t) => t.id === open.topicId) : undefined
  const suggestion =
    open?.suggestionId === undefined
      ? undefined
      : found?.suggestions.find((s) => s.id === open.suggestionId)
  // A joined topic goes whole: every group's lines and words.
  const topic =
    found === undefined || open?.suggestionId !== undefined ? found : asOne(meeting.topics, found)
  // A suggestion goes with its own group's lines, one stretch.
  const stretches =
    topic === found ? 1 : meeting.topics.filter((t) => (t.joinedTo ?? t.id) === topic?.id).length
  const title = suggestion?.title ?? (topic === undefined ? '' : topicName(topic))
  return (
    <Sheet modal={false} open={topic !== undefined} onOpenChange={(o) => !o && setOpen(null)}>
      {topic !== undefined && (
        <SheetContent
          side="right"
          // The stock sheet's own width rule is `data-[side=right]:sm:max-w-sm`;
          // only the same variant outranks it.
          className="data-[side=right]:sm:max-w-xl"
          // Beside the meeting, not over it.
          onInteractOutside={(e) => e.preventDefault()}
        >
          <SheetHeader>
            <SheetTitle>
              {/* Clear of the close button in the corner. */}
              <span className="block truncate pe-8">Send: {title}</span>
            </SheetTitle>
            <SheetDescription>
              {suggestion === undefined ? 'The topic' : `A suggestion in ${topicName(topic)}`},{' '}
              {stretches > 1
                ? `${stretches} stretches of the meeting`
                : `${clock(topic.start)}–${clock(topic.end)}`}
              , {topic.lines.length} {topic.lines.length === 1 ? 'line' : 'lines'}
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            <SendForm
              key={`${topic.id}:${suggestion?.id ?? ''}`}
              meeting={meeting}
              topic={topic}
              suggestion={suggestion}
              holis={holis}
              onDone={() => setOpen(null)}
            />
          </div>
        </SheetContent>
      )}
    </Sheet>
  )
}
