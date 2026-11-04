/**
 * One transcript line, whose words a person can correct where they read
 * them. The first line of a speaker's turn carries their name above it, so
 * a run of one speaker's lines reads as one passage; a search marks what it
 * found in the words. A click on the words opens the line for editing,
 * Enter saves and Escape puts it back. A corrected line says so, quietly. The correction
 * goes to main (`meeting.segment.edit`), which quotes it on the cards citing
 * the line and tells the scribe. A line inside a topic offers Start a new
 * topic here (`meeting.group.split`): the person draws a boundary the scribe
 * missed.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Scissors } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { activeRemoteAtom, cn } from '@/plugin-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { IconButton } from '@/composites/icon-button'
import type { Segment } from '../shared/meeting'
import { clock } from './format'
import { meetingCap } from './meeting-cap'
import { SpeakerBadge } from './speaker-badge'
import { message, putSegmentAtom, putTopicsAtom } from './state'

/** `text` with each place `find` is (any case) marked, as a find marks. */
function Marked({ text, find }: { text: string; find: string }): React.JSX.Element {
  const q = find.trim()
  if (q === '') return <>{text}</>
  const parts: React.ReactNode[] = []
  const lower = text.toLowerCase()
  const needle = q.toLowerCase()
  let from = 0
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push(text.slice(from, at))
    parts.push(
      <mark key={at} className="rounded-xs bg-(--find-match) text-inherit">
        {text.slice(at, at + q.length)}
      </mark>,
    )
    from = at + q.length
  }
  if (from < text.length) parts.push(text.slice(from))
  return <>{parts}</>
}

export function CaptionLine({
  meetingId,
  segment: s,
  marked,
  split = false,
  turn = true,
  find = '',
}: {
  meetingId: string
  segment: Segment
  marked: boolean
  /** The line is inside a topic, not its first: it can start a new one. */
  split?: boolean
  /** The first line of a speaker's turn: their name goes above it. */
  turn?: boolean
  /** What a search looks for: marked in the words. */
  find?: string
}): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const put = useSetAtom(putSegmentAtom)
  const putTopics = useSetAtom(putTopicsAtom)

  const startTopic = async () => {
    if (remote === null) return
    try {
      putTopics(meetingId, await meetingCap['group.split'](remote, { meetingId, i: s.i }))
    } catch (e) {
      toast(`The topic didn’t split: ${message(e)}`)
    }
  }
  const [draft, setDraft] = useState<string | null>(null)
  /** Set once Enter or Escape has settled the edit, so the blur that
   *  follows does not settle it again. */
  const settled = useRef(false)

  const save = async (text: string) => {
    setDraft(null)
    const words = text.replace(/\s+/g, ' ').trim()
    if (words === '' || words === s.text || remote === null) return
    // Shown at once; main's answer is the word.
    put(meetingId, { ...s, text: words, edited: true })
    try {
      put(meetingId, await meetingCap['segment.edit'](remote, { meetingId, i: s.i, text: words }))
    } catch (e) {
      put(meetingId, s)
      toast(`The correction didn’t save: ${message(e)}`)
    }
  }

  return (
    <li
      data-segment={s.i}
      aria-current={marked ? 'true' : undefined}
      className={cn(
        'group/line flex min-w-0 flex-col gap-1 rounded-md px-2 py-1',
        turn && 'pt-2',
        marked && 'bg-accent',
      )}
    >
      {turn && (
        <span className="flex">
          <SpeakerBadge speaker={s.speaker} />
        </span>
      )}
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="w-8 shrink-0 text-xs text-muted-foreground tabular-nums">
          {clock(s.start)}
        </span>
        {draft === null ? (
          // As wide as its words, so its hover stays on them and `edited`
          // follows the text rather than the row's far edge; never wider
          // than the column, so a long line wraps.
          <Button
            variant="ghost"
            size="inline"
            className="min-w-0 shrink justify-start text-left text-sm"
            onClick={() => {
              settled.current = false
              setDraft(s.text)
            }}
          >
            <span className="min-w-0 wrap-break-word">
              <Marked text={s.text} find={find} />
            </span>
          </Button>
        ) : (
          <Input
            aria-label={`Line ${s.i}`}
            className="min-w-0 flex-1"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                settled.current = true
                void save(draft)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                settled.current = true
                setDraft(null)
              }
            }}
            onBlur={() => {
              if (!settled.current) void save(draft)
            }}
          />
        )}
        {s.edited === true && draft === null && (
          <span className="shrink-0 text-xs text-muted-foreground italic">edited</span>
        )}
        {split && draft === null && (
          // Quiet until the line is hovered or focused: a boundary is rare.
          <span className="ms-auto shrink-0 self-center opacity-0 group-focus-within/line:opacity-100 group-hover/line:opacity-100">
            <IconButton
              label="Start a new topic here"
              size="icon-xs"
              onClick={() => void startTopic()}
            >
              <Scissors aria-hidden />
            </IconButton>
          </span>
        )}
      </span>
    </li>
  )
}
