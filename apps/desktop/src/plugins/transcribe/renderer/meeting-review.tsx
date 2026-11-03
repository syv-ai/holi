/**
 * A meeting that has stopped: where Stop lands, and what a past meeting
 * opens on. Its title (renamed in place, or the meeting deleted, from its
 * menu), date and length with Copy transcript, Export minutes and Open in
 * vault; then the minutes as its topics, each still editable and
 * sendable, with the decisions and open questions above them
 * (`group-sections.tsx`); its Tasks (each sent with its run as it stands, or
 * made and not sent yet, and Custom range); and the whole transcript, under
 * its topics' headings, a speaker's run of lines under their name once,
 * searchable, with misheard words replaced in one go (`transcript-find.tsx`),
 * editable and copied from its own header.
 * The transcript is copied only here, once the meeting is over.
 */
import type { PickableHoli } from '@holi/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { Copy, FileText } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { openPathAtom } from '@/plugin-api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { speakerName, type MeetingState, type Segment } from '../shared/meeting'
import { CaptionLine } from './caption-line'
import { ExportMinutes } from './export-minutes'
import { clock } from './format'
import { GroupSections } from './group-sections'
import { MeetingMenu, TitleEditor } from './meeting-actions'
import { MeetingProblems } from './meeting-view'
import { SendPanel } from './send-panel'
import { highlightAtom } from './state'
import { TaskPanel } from './task-panel'
import { TasksRail } from './tasks-rail'
import { topicIndex, topicName } from './topic-index'
import { TranscriptFind } from './transcript-find'
import { transcriptText } from './transcript-text'

const stamp = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** How long the meeting ran, from its segments when it has no end. */
function lengthOf(meeting: MeetingState): string | null {
  const end = meeting.endedAt
  if (end !== undefined) return clock((end - meeting.startedAt) / 1000)
  const last = meeting.segments.at(-1)
  return last === undefined ? null : clock(last.end)
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">{title}</h2>
      {children}
    </section>
  )
}

/** The transcript to the clipboard, one `[m:ss] Speaker: text` line each. */
function CopyTranscript({
  meeting,
  variant = 'secondary',
}: {
  meeting: MeetingState
  variant?: 'secondary' | 'ghost'
}): React.JSX.Element {
  return (
    <Button
      size="sm"
      variant={variant}
      disabled={meeting.segments.length === 0}
      onClick={() =>
        void navigator.clipboard
          ?.writeText(transcriptText(meeting.segments))
          .then(() => toast('Transcript copied'))
      }
    >
      <Copy aria-hidden />
      Copy transcript
    </Button>
  )
}

function Transcript({ meeting }: { meeting: MeetingState }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const highlight = useAtomValue(highlightAtom)
  const mark = highlight?.meetingId === meeting.id ? highlight.i : null
  const topics = topicIndex(meeting)
  const q = query.trim().toLowerCase()
  const lines =
    q === ''
      ? meeting.segments
      : meeting.segments.filter(
          (s) =>
            s.text.toLowerCase().includes(q) || speakerName(s.speaker).toLowerCase().includes(q),
        )
  if (meeting.segments.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing was transcribed in this meeting.</p>
  }
  /** One list of lines, a speaker's run under their name once. */
  const list = (label: string, shown: readonly Segment[], split: boolean) => (
    <ol aria-label={label} className="flex flex-col">
      {shown.map((s, k) => (
        <CaptionLine
          key={s.i}
          meetingId={meeting.id}
          segment={s}
          turn={k === 0 || shown[k - 1]!.speaker !== s.speaker}
          find={query}
          marked={mark === s.i}
          split={split && topics.canSplit(s.i)}
        />
      ))}
    </ol>
  )
  return (
    <div className="flex flex-col gap-2">
      <TranscriptFind
        meetingId={meeting.id}
        query={query}
        onQuery={setQuery}
        matches={lines.length}
        actions={<CopyTranscript meeting={meeting} variant="ghost" />}
      />
      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">No line says “{query.trim()}”.</p>
      ) : q === '' && meeting.topics.length > 0 ? (
        // Unsearched, the transcript reads under its topics.
        <div className="flex flex-col gap-4">
          {meeting.topics.map((t) => (
            <div key={t.id} className="flex flex-col gap-1">
              <h3 className="flex items-baseline gap-2 px-2 text-sm font-medium">
                {topicName(t)}
                <span className="text-xs font-normal text-muted-foreground tabular-nums">
                  {clock(t.start)}
                </span>
              </h3>
              {list(
                topicName(t),
                lines.filter((s) => t.lines.includes(s.i)),
                true,
              )}
            </div>
          ))}
        </div>
      ) : (
        list('Transcript', lines, false)
      )}
    </div>
  )
}

export function MeetingReview({
  meeting,
  holis,
}: {
  meeting: MeetingState
  holis: readonly PickableHoli[]
}): React.JSX.Element {
  const openPath = useSetAtom(openPathAtom)
  const length = lengthOf(meeting)
  const hasMinutes = meeting.minutes.trim() !== '' && meeting.minutesPath !== undefined
  const [renaming, setRenaming] = useState(false)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-6">
        <header className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              {renaming ? (
                <TitleEditor meeting={meeting} onDone={() => setRenaming(false)} />
              ) : (
                <h1 className="min-w-0 text-2xl font-semibold tracking-tight">{meeting.title}</h1>
              )}
              <MeetingMenu meeting={meeting} onRename={() => setRenaming(true)} />
            </div>
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>{stamp.format(new Date(meeting.startedAt))}</span>
              {length !== null && <span className="tabular-nums">· {length}</span>}
              {meeting.phase === 'finishing' && (
                <Badge variant="secondary">
                  <Spinner />
                  Finishing the minutes
                </Badge>
              )}
              {meeting.phase === 'failed' && <Badge variant="destructive-light">Failed</Badge>}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <CopyTranscript meeting={meeting} />
            <ExportMinutes meeting={meeting} disabled={!hasMinutes} />
            <Button
              size="sm"
              variant="ghost"
              disabled={!hasMinutes}
              onClick={() => meeting.minutesPath !== undefined && openPath(meeting.minutesPath)}
            >
              <FileText aria-hidden />
              Open in vault
            </Button>
          </div>
        </header>
        <MeetingProblems meeting={meeting} />
        <GroupSections meeting={meeting} live={false} />
        <TasksRail meeting={meeting} />
        <Section title="Transcript">
          <Transcript meeting={meeting} />
        </Section>
      </div>
      <TaskPanel meeting={meeting} holis={holis} />
      <SendPanel meeting={meeting} holis={holis} />
    </div>
  )
}
