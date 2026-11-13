/**
 * How a recording meeting is doing, in the header's one row, each part named
 * for what it is, so a problem says which part needs fixing: a chip with a
 * dot and how the topics are doing, which opens the details (what records,
 * the transcription, how far the captions run behind, the topics and
 * the assistant's session, and what to do about a part that stopped); a loud badge
 * for each problem (transcription waiting for a key or refused one, failed
 * uploads, topics the vault's agent cannot write); and the recording reminder,
 * which stays for as long as the meeting records.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'
import { Circle, SquareArrowOutUpRight } from 'lucide-react'
import { agentSessionRowsAtom, cn, showAgentSessionAtom } from '@/plugin-api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ChunkInfo, ChunkState, MeetingState, ScribeState } from '../shared/meeting'
import { useAgentName } from './agent-name'
import { useMeetingsDisplayed } from './displayed'
import { SCRIBE_NAME, SCRIBE_TITLE } from './names'
import { recorderAtom } from './recorder'
import { scribeStateOf, unsupportedReason } from './scribe-ready'

/** How the topics are doing: "Topics: listening". */
const DOING: Record<ScribeState, string> = {
  off: 'off',
  starting: 'starting',
  working: 'writing',
  idle: 'listening',
  'needs-you': 'need you',
  gone: 'stopped',
}

/** The chip's dot: well, busy, wants a look, or stopped. */
const DOT: Record<ScribeState, string> = {
  off: 'bg-muted-foreground',
  starting: 'bg-info',
  working: 'bg-info',
  idle: 'bg-success',
  'needs-you': 'bg-warning',
  gone: 'bg-destructive',
}

/** What the meeting's chunks and scribe come to, for the chip, the badges
 *  and the details alike. */
function useHealth(meeting: MeetingState) {
  const sessions = useAtomValue(agentSessionRowsAtom)
  const inState = (...states: ChunkState[]): ChunkInfo[] =>
    meeting.chunks.filter((c) => states.includes(c.state))
  const scribe = meeting.scribeSessionId
  const row = sessions.find((s) => s.id === scribe)
  return {
    waiting: inState('queued', 'uploading'),
    failed: inState('failed'),
    lag: meeting.chunks.filter((c) => c.state === 'done' && c.latencyMs !== undefined).at(-1),
    scribe,
    live: scribe !== undefined && row !== undefined,
    state: scribeStateOf(meeting, row),
  }
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right tabular-nums">{children}</span>
    </div>
  )
}

/** The chip, its details, and the problem badges beside it. */
export function MeetingStatus({ meeting }: { meeting: MeetingState }): React.JSX.Element {
  const show = useSetAtom(showAgentSessionAtom)
  const displayed = useMeetingsDisplayed()
  const [detailsOpen, setDetailsOpen] = useState(false)
  useEffect(() => {
    if (!displayed) setDetailsOpen(false)
  }, [displayed])
  const rec = useAtomValue(recorderAtom)
  const agent = useAgentName()
  const { waiting, failed, lag, scribe, live, state } = useHealth(meeting)
  const transcription =
    waiting.length === 0
      ? 'All transcribed'
      : meeting.blocked !== undefined
        ? `${waiting.length} waiting for a key`
        : `${waiting.length} transcribing`
  const sources =
    rec.meetingId === meeting.id && rec.sources !== null
      ? [rec.sources.microphone && 'Microphone', rec.sources.system && 'Computer audio']
          .filter(Boolean)
          .join(' and ')
      : null
  const unsupported = meeting.scribeUnsupported !== undefined
  const topics = unsupported ? 'off' : DOING[state]
  /** What to do about topics that stopped or cannot run; the recording
   *  and the captions go on either way. */
  const fix = unsupported
    ? `${unsupportedReason(agent)} Recording and captions go on. Choose one in Settings › General › Agents, then start the assistant under Now.`
    : state === 'gone'
      ? `${SCRIBE_TITLE}, the session that writes the topics, ended. Recording and captions go on; open its session to see why.`
      : null

  return (
    <div aria-label="Meeting health" className="flex min-w-0 items-center gap-1">
      <Popover
        open={displayed && detailsOpen}
        onOpenChange={(next) => setDetailsOpen(displayed && next)}
      >
        <PopoverTrigger asChild>
          <Button variant="ghost" size="xs">
            {state === 'starting' || state === 'working' ? (
              <Spinner />
            ) : (
              <span aria-hidden className={cn('size-2 shrink-0 rounded-full', DOT[state])} />
            )}
            Topics {topics}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" aria-label="Meeting details">
          <PopoverHeader>
            <PopoverTitle>How the meeting is doing</PopoverTitle>
            <PopoverDescription>
              {SCRIBE_TITLE} hears the transcript as it comes and groups it into the topics the
              minutes are built from.
            </PopoverDescription>
          </PopoverHeader>
          <div className="flex flex-col gap-1.5">
            {sources !== null && <Detail label="Recording">{sources}</Detail>}
            <Detail label="Transcription">{transcription}</Detail>
            {failed.length > 0 && (
              <Detail label="Failed">
                {failed.map((c) => `Chunk ${c.n}: ${c.error ?? 'failed'}`).join(' · ')}
              </Detail>
            )}
            {lag?.latencyMs !== undefined && (
              <Detail label="Captions">{(lag.latencyMs / 1000).toFixed(1)}s behind</Detail>
            )}
            <Detail label="Topics">{topics}</Detail>
          </div>
          {fix !== null && <p className="text-sm text-muted-foreground">{fix}</p>}
          {scribe !== undefined && (
            <Button
              size="sm"
              variant={state === 'needs-you' ? 'default' : 'secondary'}
              onClick={() => void show({ session: scribe, live })}
            >
              <SquareArrowOutUpRight aria-hidden />
              Open {SCRIBE_NAME}’s session
            </Button>
          )}
        </PopoverContent>
      </Popover>
      {meeting.blocked === 'no-key' && (
        <Badge variant="warning-light">Transcription needs a key</Badge>
      )}
      {meeting.blocked === 'bad-key' && (
        <Badge variant="destructive-light">Transcription key refused</Badge>
      )}
      {failed.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="destructive-light" tabIndex={0}>
              {failed.length} not transcribed
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            {failed.map((c) => `Chunk ${c.n}: ${c.error ?? 'failed'}`).join(' · ')}
          </TooltipContent>
        </Tooltip>
      )}
      {meeting.scribeUnreachable === true && (
        <Badge variant="warning-light">Topics unreachable</Badge>
      )}
      {unsupported && <Badge variant="warning-light">No topics with this agent</Badge>}
    </div>
  )
}

/** The reminder that the meeting is being recorded: loud, and there for as
 *  long as it records. */
export function RecordingPill(): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="warning" radius="full" role="status" tabIndex={0}>
          <Circle aria-hidden className="fill-current" />
          Recording · tell everyone
        </Badge>
      </TooltipTrigger>
      <TooltipContent>Let everyone in the meeting know Holi is transcribing it.</TooltipContent>
    </Tooltip>
  )
}
