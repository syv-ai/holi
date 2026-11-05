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
import { activeRemoteAtom, useNow } from '@/plugin-api'
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
  onDone,
}: {
  meeting: MeetingState
  onDone: () => void
}): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const put = useSetAtom(putCardAtom)
  const openTask = useSetAtom(openTaskAtom)
  const promptId = useId()
  const now = useNow(1000)
  const length = lengthOf(meeting, now)
  const topics = meeting.topics
    .filter((t) => !t.open && t.title !== '')
    .map((t) => ({
      id: `topic-${t.id}`,
      label: t.title,
      range: [Math.floor(t.start), Math.min(length, Math.ceil(t.end))] as const,
    }))
  const [range, setRange] = useState<Range>(() => [Math.max(0, length - 300), length])
  const [preset, setPreset] = useState('last-5')
  const [prompt, setPrompt] = useState('')
  const [kind, setKind] = useState<CardKind>('feature')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [start, end] = range
  const lines = linesIn(meeting, range)
  const first = lines[0]
  const last = lines.at(-1)
  const canCreate = !busy && prompt.trim() !== '' && lines.length > 0 && remote !== null

  const pick = (id: string) => {
    if (id === '') return
    setPreset(id)
    const lastN = LAST.find((p) => p.id === id)
    if (lastN !== undefined) setRange([Math.max(0, length - lastN.seconds), length])
    else if (id === 'whole') setRange([0, length])
    else {
      const t = topics.find((x) => x.id === id)
      if (t !== undefined) setRange(t.range)
    }
  }

  const create = async () => {
    if (!canCreate) return
    setBusy(true)
    setError(null)
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
      setError(`The ${TASK_NAME.toLowerCase()} wasn’t made: ${message(e)}`)
    } finally {
      setBusy(false)
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
              setRange([a, b])
              setPreset('')
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
            onChange={(e) => setPrompt(e.target.value)}
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
            onValueChange={(v) => v !== '' && setKind(v as CardKind)}
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>A {TASK_NAME.toLowerCase()} from a custom range</DialogTitle>
          <DialogDescription>
            Pick a stretch of the meeting and say what should be done with it. {SCRIBE_TITLE} hears
            that you made it, and suggests nothing of its own for the same thing.
          </DialogDescription>
        </DialogHeader>
        {open && <CustomRangeForm meeting={meeting} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}
