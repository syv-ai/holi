/**
 * The meeting's words as they arrive. Folded, as a meeting starts: a strip
 * with the last two lines, quiet, and Show transcript. Shown: the whole
 * transcript in a column that follows the newest line unless the person
 * scrolls up, with Hide transcript. A quote clicked on a task scrolls to its
 * line and marks it. The column reads under the topics' headings, a
 * speaker's lines in a row under their name once, and each
 * line's words can be corrected in place, or a new topic started at it
 * (`caption-line.tsx`).
 */
import { useAtomValue } from 'jotai'
import { ArrowDown, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { speakerName, type MeetingState } from '../shared/meeting'
import { CaptionLine } from './caption-line'
import { clock } from './format'
import { highlightAtom } from './state'
import { topicIndex, topicName } from './topic-index'

/** The last lines said, in one quiet strip, and the way to the whole
 *  transcript. */
export function CaptionStrip({
  meeting,
  onShow,
}: {
  meeting: MeetingState
  onShow: () => void
}): React.JSX.Element {
  const latest = meeting.segments.slice(-2)
  return (
    <section aria-label="Latest captions" className="flex min-w-0 items-start gap-2">
      {latest.length === 0 ? (
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          Listening. Captions appear a few seconds after someone speaks.
        </p>
      ) : (
        <ol className="flex min-w-0 flex-1 flex-col gap-0.5">
          {latest.map((s) => (
            <li
              key={s.i}
              className="flex min-w-0 items-baseline gap-2 text-sm text-muted-foreground"
            >
              <span className="shrink-0 text-xs font-medium">{speakerName(s.speaker)}</span>
              <span className="min-w-0 truncate">{s.text}</span>
            </li>
          ))}
        </ol>
      )}
      <Button variant="ghost" size="xs" className="shrink-0" onClick={onShow}>
        <PanelLeftOpen aria-hidden />
        Show transcript
      </Button>
    </section>
  )
}

export function LiveCaptions({
  meeting,
  onHide,
}: {
  meeting: MeetingState
  /** Folds the column back into the strip; absent where it cannot fold. */
  onHide?: () => void
}): React.JSX.Element {
  const highlight = useAtomValue(highlightAtom)
  const mark = highlight?.meetingId === meeting.id ? highlight.i : null
  const [following, setFollowing] = useState(true)
  const scroller = useRef<HTMLOListElement>(null)
  const live = meeting.phase === 'recording'
  const last = meeting.segments.at(-1)?.i
  const topics = topicIndex(meeting)

  // A quote was clicked: stop following and find its line.
  useEffect(() => {
    if (mark === null) return
    setFollowing(false)
    scroller.current?.querySelector(`[data-segment="${mark}"]`)?.scrollIntoView({ block: 'center' })
  }, [highlight, mark])

  useLayoutEffect(() => {
    const el = scroller.current
    if (following && el !== null) el.scrollTop = el.scrollHeight
  }, [following, last])

  return (
    <section aria-label="Captions" className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex shrink-0 items-center gap-2 px-2">
        <h2 className="text-xs font-medium text-muted-foreground">Captions</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {meeting.segments.length > 0 && `${meeting.segments.length} lines`}
        </span>
        {onHide !== undefined && (
          <Button variant="ghost" size="xs" className="ms-auto" onClick={onHide}>
            <PanelLeftClose aria-hidden />
            Hide transcript
          </Button>
        )}
      </div>
      {meeting.segments.length === 0 ? (
        <p className="px-2 text-sm text-muted-foreground">
          {live
            ? 'Listening. Captions appear a few seconds after someone speaks.'
            : 'Nothing was transcribed in this meeting.'}
        </p>
      ) : (
        <div className="relative min-h-0 flex-1">
          <ol
            ref={scroller}
            aria-label="Transcript"
            className="flex h-full flex-col gap-0.5 overflow-y-auto"
            onScroll={(e) => {
              const el = e.currentTarget
              setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
            }}
          >
            {meeting.segments.map((s, k) => {
              const topic = topics.startsAt.get(s.i)
              const prev = meeting.segments[k - 1]
              return (
                <Fragment key={s.i}>
                  {topic !== undefined && (
                    <li className="flex items-baseline gap-2 px-2 pt-3 pb-1">
                      <span className="min-w-0 truncate text-xs font-medium">
                        {topicName(topic)}
                      </span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {clock(topic.start)}
                      </span>
                    </li>
                  )}
                  <CaptionLine
                    meetingId={meeting.id}
                    segment={s}
                    turn={topic !== undefined || prev?.speaker !== s.speaker}
                    marked={mark === s.i}
                    split={topics.canSplit(s.i)}
                  />
                </Fragment>
              )
            })}
          </ol>
          {live && !following && (
            <Button
              variant="secondary"
              size="xs"
              className="absolute right-2 bottom-2"
              onClick={() => setFollowing(true)}
            >
              <ArrowDown aria-hidden />
              Back to live
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
