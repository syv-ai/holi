/**
 * A meeting while it records, laid out for a glance mid-call: the minutes in
 * the middle at a readable width, as the meeting's topics (`group-sections.tsx`),
 * following the newest unless the person scrolled up; the Tasks rail on the
 * right (`tasks-rail.tsx`); and the captions folded into a strip under the
 * minutes with the last two lines, until the person shows the whole
 * transcript as a column on the left (the choice is kept on this machine). A
 * topic is sent from a panel on the right (`send-panel.tsx`), and a task
 * opens in one (`task-panel.tsx`). In a narrow window the three are tabs.
 * What stops the meeting working (no speech key, a Hviske that takes no
 * messages) shows under the header with what fixes it, and only then.
 */
import type { PickableHoli } from '@holi/shared'
import { useAtom, useAtomValue } from 'jotai'
import { MessageSquareOff } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { MeetingState } from '../shared/meeting'
import { GroupSections } from './group-sections'
import { CaptionStrip, LiveCaptions } from './live-captions'
import { SCRIBE_NAME, TASKS_NAME } from './names'
import { SendPanel } from './send-panel'
import { SpeechKeyBlocked } from './speech-key'
import { highlightAtom, showTranscriptAtom } from './state'
import { TaskPanel } from './task-panel'
import { TasksRail } from './tasks-rail'
import { useWide } from './use-wide'

/** Below this width the three columns become tabs. */
const WIDE_PX = 900

type Region = 'captions' | 'minutes' | 'tasks'

/** How close to the bottom counts as at it: the minutes follow from there. */
const FOLLOW_PX = 24

/** Whether something stops the meeting working. */
const hasProblems = (meeting: MeetingState): boolean =>
  meeting.blocked !== undefined || meeting.scribeUnreachable === true

/** What stops the meeting working, with what fixes it. */
export function MeetingProblems({ meeting }: { meeting: MeetingState }): React.JSX.Element {
  return (
    <>
      {meeting.blocked !== undefined && <SpeechKeyBlocked reason={meeting.blocked} />}
      {meeting.scribeUnreachable === true && (
        <Alert variant="warning">
          <MessageSquareOff aria-hidden />
          <AlertTitle>{SCRIBE_NAME} isn’t receiving the transcript.</AlertTitle>
          <AlertDescription>
            Update this vault’s skills (account menu → Update skills), then start a new meeting.
          </AlertDescription>
        </Alert>
      )}
    </>
  )
}

/** The topics, scrolled to the newest while the person has not scrolled up. */
function MinutesColumn({
  meeting,
  strip,
}: {
  meeting: MeetingState
  /** The caption strip under the minutes, when the column is not shown. */
  strip: React.ReactNode
}): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  const newest = `${meeting.segments.length}:${meeting.topics.length}:${meeting.minutesAt ?? 0}`
  useLayoutEffect(() => {
    const el = scroller.current
    if (following && el !== null) el.scrollTop = el.scrollHeight
  }, [following, newest])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-4"
        onScroll={(e) => {
          const el = e.currentTarget
          setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_PX)
        }}
      >
        <div className="mx-auto max-w-prose">
          <GroupSections meeting={meeting} live />
        </div>
      </div>
      {strip}
    </div>
  )
}

export function MeetingView({
  meeting,
  holis,
}: {
  meeting: MeetingState
  holis: readonly PickableHoli[]
}): React.JSX.Element {
  const body = useRef<HTMLDivElement>(null)
  const wide = useWide(body, WIDE_PX)
  const [tab, setTab] = useState<Region>('minutes')
  const [showTranscript, setShowTranscript] = useAtom(showTranscriptAtom)
  /** Shown for a quote's sake, without changing the kept choice. */
  const [peek, setPeek] = useState(false)
  const transcript = showTranscript || peek
  const highlight = useAtomValue(highlightAtom)
  // A quote clicked on a task shows its line, in a narrow window too.
  useEffect(() => {
    if (highlight?.meetingId !== meeting.id) return
    setTab('captions')
    setPeek(true)
  }, [highlight, meeting.id])

  const show = () => (wide ? setShowTranscript(true) : setTab('captions'))
  const hide = () => {
    setShowTranscript(false)
    setPeek(false)
  }
  const minutes = (
    <MinutesColumn
      meeting={meeting}
      strip={
        !(wide && transcript) && (
          <div className="shrink-0 border-t border-divider px-6 py-2">
            <div className="mx-auto max-w-prose">
              <CaptionStrip meeting={meeting} onShow={show} />
            </div>
          </div>
        )
      }
    />
  )
  const tasks = <TasksRail meeting={meeting} />

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {hasProblems(meeting) && (
        <div className="flex shrink-0 flex-col gap-2 border-b border-divider px-4 py-2">
          <MeetingProblems meeting={meeting} />
        </div>
      )}
      <div ref={body} className="flex min-h-0 flex-1">
        {wide ? (
          <>
            {transcript && (
              <div className="w-2/7 shrink-0 border-e border-divider py-3 ps-2">
                <LiveCaptions meeting={meeting} onHide={hide} />
              </div>
            )}
            <div className="min-w-0 flex-1">{minutes}</div>
            <div className="w-75 shrink-0 overflow-y-auto border-s border-divider px-2 py-3">
              {tasks}
            </div>
          </>
        ) : (
          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as Region)}
            className="flex min-h-0 flex-1 flex-col"
          >
            <TabsList className="mx-4 mt-2 shrink-0">
              <TabsTrigger value="minutes">Minutes</TabsTrigger>
              <TabsTrigger value="captions">Transcript</TabsTrigger>
              <TabsTrigger value="tasks">{TASKS_NAME}</TabsTrigger>
            </TabsList>
            <TabsContent value="captions" className="min-h-0">
              <div className="h-full py-2 ps-2">
                <LiveCaptions meeting={meeting} />
              </div>
            </TabsContent>
            <TabsContent value="minutes" className="min-h-0">
              {minutes}
            </TabsContent>
            <TabsContent value="tasks" className="min-h-0 overflow-y-auto">
              <div className="p-2">{tasks}</div>
            </TabsContent>
          </Tabs>
        )}
      </div>
      <TaskPanel meeting={meeting} holis={holis} />
      <SendPanel meeting={meeting} holis={holis} />
    </div>
  )
}
