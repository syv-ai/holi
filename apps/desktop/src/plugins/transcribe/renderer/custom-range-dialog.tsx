/**
 * A task a person makes from a stretch of the meeting that is not one topic
 * (Custom range, in the Tasks rail's header): a time range picked on the
 * meeting's timeline with two thumbs, or with a preset (the last few
 * minutes, the whole meeting, or a topic), what they want done with what was
 * said there, and whether it is a feature or a to-do. Main makes it at once
 * with every line in the range (`meeting.task.create`), and it opens in the
 * task panel, ready to send.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useId, useState } from 'react'
import { activeRemoteAtom } from '@/plugin-api'
import { useDisplayedNow, useMeetingsDisplayed } from './displayed'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldLabel, FieldTitle } from '@/components/ui/field'
import { Slider } from '@/components/ui/slider'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { MAX_PROMPT, type CardKind, type MeetingState, type Segment } from '../shared/meeting'
import { clock } from '../shared/scribe-prompt'
import { meetingCap } from './meeting-cap'
import { SCRIBE_TITLE, TASK_NAME } from './names'
import { SpeakerBadge } from './speaker-badge'
import { message, openTaskAtom, putCardAtom } from './state'

const LAST: ReadonlyArray<{ id: string; label: string; seconds: number }> = [
  { id: 'last-2', label: 'Last 2 min', seconds: 120 },
  { id: 'last-5', label: 'Last 5 min', seconds: 300 },
  { id: 'last-10', label: 'Last 10 min', seconds: 600 },
]

type Range = readonly [number, number]
type CustomRangeDraft = {
  range: Range | null
  preset: string
  prompt: string
  kind: CardKind
  busy: boolean
  error: string | null
}

/** A row of preset chips over the slider. */
function PresetRow({
  label,
  items,
  value,
  onPick,
}: {
  label: string
  items: ReadonlyArray<{ id: string; label: string }>
  value: string
  onPick: (id: string) => void
}): React.JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        spacing={1}
        aria-label={label}
        value={value}
        onValueChange={onPick}
        className="flex-wrap"
      >
        {items.map((m) => (
          <ToggleGroupItem key={m.id} value={m.id}>
            {m.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}

/** The meeting's length in whole seconds: to now while it records, else to
 *  its end, or to its last line when that runs later. */
function lengthOf(meeting: MeetingState, now: number): number {
  const clockS = ((meeting.endedAt ?? now) - meeting.startedAt) / 1000
  return Math.max(1, Math.floor(Math.max(clockS, meeting.segments.at(-1)?.end ?? 0)))
}

const linesIn = (meeting: MeetingState, [start, end]: Range): Segment[] =>
  meeting.segments.filter((s) => s.start < end && s.end > start)

function PreviewLine({ segment }: { segment: Segment }): React.JSX.Element {
  return (
    <li className="flex min-w-0 items-baseline gap-2">
      <SpeakerBadge speaker={segment.speaker} />
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {clock(segment.start)}
      </span>
      <span className="min-w-0 truncate text-sm">{segment.text}</span>
    </li>
  )
}

function CustomRangeForm({
  meeting,
  draft,
  setDraft,
  onDone,
}: {
  meeting: MeetingState
  draft: CustomRangeDraft
  setDraft: React.Dispatch<React.SetStateAction<CustomRangeDraft>>
  onDone: () => void
}): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const put = useSetAtom(putCardAtom)
  const openTask = useSetAtom(openTaskAtom)
  const promptId = useId()
  const now = useDisplayedNow(1000)
  const length = lengthOf(meeting, now)
  const topics = meeting.topics
    .filter((t) => !t.open && t.title !== '')
    .map((t) => ({
      id: `topic-${t.id}`,
      label: t.title,
      range: [Math.floor(t.start), Math.min(length, Math.ceil(t.end))] as const,
    }))
  const { preset, prompt, kind, busy, error } = draft
  const range = draft.range ?? [Math.max(0, length - 300), length]
  const [start, end] = range
  const lines = linesIn(meeting, range)
  const first = lines[0]
  const last = lines.at(-1)
  const canCreate = !busy && prompt.trim() !== '' && lines.length > 0 && remote !== null

  const pick = (id: string) => {
    if (id === '') return
    setDraft((d) => ({ ...d, preset: id }))
    const lastN = LAST.find((p) => p.id === id)
    if (lastN !== undefined)
      setDraft((d) => ({ ...d, range: [Math.max(0, length - lastN.seconds), length] }))
    else if (id === 'whole') setDraft((d) => ({ ...d, range: [0, length] }))
    else {
      const t = topics.find((x) => x.id === id)
      if (t !== undefined) setDraft((d) => ({ ...d, range: t.range }))
    }
  }

  const create = async () => {
    if (!canCreate) return
    setDraft((d) => ({ ...d, busy: true, error: null }))
    try {
      const card = await meetingCap['task.create'](remote, {
        meetingId: meeting.id,
        lines: lines.map((s) => s.i),
        prompt: prompt.trim(),
        kind,
      })
      put(meeting.id, card)
      openTask({ meetingId: meeting.id, cardId: card.id })
      onDone()
    } catch (e) {
      setDraft((d) => ({
        ...d,
        error: `The ${TASK_NAME.toLowerCase()} wasn’t made: ${message(e)}`,
      }))
    } finally {
      setDraft((d) => ({ ...d, busy: false }))
    }
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        <Field>
          <div className="flex items-baseline justify-between gap-2">
            <FieldTitle>Time range</FieldTitle>
            <span aria-label="Range" className="text-sm tabular-nums">
              {clock(start)} – {clock(end)}
            </span>
          </div>
          <Slider
            aria-label="Time range"
            min={0}
            max={length}
            step={1}
            minStepsBetweenThumbs={1}
            value={[start, end]}
            onValueChange={([a, b]) => {
              if (a === undefined || b === undefined) return
              setDraft((d) => ({ ...d, range: [a, b], preset: '' }))
            }}
          />
          <div className="flex flex-wrap gap-1">
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              spacing={1}
              aria-label="Presets"
              value={preset}
              onValueChange={pick}
              className="flex-wrap"
            >
              {LAST.map((p) => (
                <ToggleGroupItem key={p.id} value={p.id}>
                  {p.label}
                </ToggleGroupItem>
              ))}
              <ToggleGroupItem value="whole">Whole meeting</ToggleGroupItem>
            </ToggleGroup>
          </div>
          <PresetRow label="Topics" items={topics} value={preset} onPick={pick} />
          <div
            role="status"
            aria-label="Lines in range"
            className="flex flex-col gap-1 rounded-md bg-muted p-2"
          >
            {first === undefined || last === undefined ? (
              <p className="text-sm text-muted-foreground">Nothing was said in this range.</p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {lines.length === 1 ? '1 line' : `${lines.length} lines`}
                </p>
                <ul className="flex flex-col gap-1">
                  <PreviewLine segment={first} />
                  {last !== first && <PreviewLine segment={last} />}
                </ul>
              </>
            )}
          </div>
        </Field>
        <Field>
          <FieldLabel htmlFor={promptId}>What should be done?</FieldLabel>
          <Textarea
            id={promptId}
            placeholder="e.g. Turn this into a spec for the CI change"
            maxLength={MAX_PROMPT}
            value={prompt}
            onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))}
          />
          <FieldDescription>
            The first line is the task’s title. The agent you send it to gets every line in the
            range.
          </FieldDescription>
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
            onValueChange={(v) => v !== '' && setDraft((d) => ({ ...d, kind: v as CardKind }))}
          >
            <ToggleGroupItem value="feature">Feature</ToggleGroupItem>
            <ToggleGroupItem value="action">To-do</ToggleGroupItem>
          </ToggleGroup>
        </Field>
        {error !== null && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button disabled={!canCreate} onClick={() => void create()}>
          {busy && <Spinner />}
          Create task
        </Button>
      </DialogFooter>
    </>
  )
}

export function CustomRangeDialog({
  meeting,
  open,
  onOpenChange,
}: {
  meeting: MeetingState
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const displayed = useMeetingsDisplayed()
  const [draft, setDraft] = useState<CustomRangeDraft>(() => ({
    range: null,
    preset: 'last-5',
    prompt: '',
    kind: 'feature',
    busy: false,
    error: null,
  }))
  const close = () => {
    setDraft({
      range: null,
      preset: 'last-5',
      prompt: '',
      kind: 'feature',
      busy: false,
      error: null,
    })
    onOpenChange(false)
  }
  return (
    <Dialog
      open={open && displayed}
      modal={open && displayed}
      onOpenChange={(next) => displayed && (next ? onOpenChange(true) : close())}
    >
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>A {TASK_NAME.toLowerCase()} from a custom range</DialogTitle>
          <DialogDescription>
            Pick a stretch of the meeting and say what should be done with it. {SCRIBE_TITLE} hears
            that you made it, and suggests nothing of its own for the same thing.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <CustomRangeForm meeting={meeting} draft={draft} setDraft={setDraft} onDone={close} />
        )}
      </DialogContent>
    </Dialog>
  )
}
