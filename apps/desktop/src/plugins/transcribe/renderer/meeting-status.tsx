/**
 * How a recording meeting is doing, in the header's one row: a chip with a
 * dot and what Hviske is doing, which opens the details (audio transcribed,
 * waiting or failed, how far the captions run behind, Hviske's state and its
 * session); a loud badge for each problem (no speech key or a refused one,
 * failed uploads, a Hviske that takes no messages); and the recording
 * reminder, which stays for as long as the meeting records.
 */
import { useAtomValue, useSetAtom } from 'jotai'
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
import { SCRIBE_NAME } from './names'

/** What the scribe is doing, after its name: "Hviske listening". */
const DOING: Record<ScribeState, string> = {
  off: 'off',
  starting: 'starting',
  working: 'writing',
  idle: 'listening',
  'needs-you': 'needs you',
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
  // The agent's own word is fresher than the last meeting event.
  const row = sessions.find((s) => s.id === scribe)
  return {
    waiting: inState('queued', 'uploading'),
    failed: inState('failed'),
    lag: meeting.chunks.filter((c) => c.state === 'done' && c.latencyMs !== undefined).at(-1),
    scribe,
    live: scribe !== undefined && row !== undefined,
    state: (row?.state === 'needs-you' ? 'needs-you' : meeting.scribeState) as ScribeState,
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
  const { waiting, failed, lag, scribe, live, state } = useHealth(meeting)
  const audio =
    waiting.length === 0
      ? 'All transcribed'
      : meeting.blocked !== undefined
        ? `${waiting.length} waiting for a key`
        : `${waiting.length} transcribing`

  return (
    <div aria-label="Meeting health" className="flex min-w-0 items-center gap-1">
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="xs">
            {state === 'starting' || state === 'working' ? (
              <Spinner />
            ) : (
              <span aria-hidden className={cn('size-2 shrink-0 rounded-full', DOT[state])} />
            )}
            {SCRIBE_NAME} {DOING[state]}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" aria-label="Meeting details">
          <PopoverHeader>
            <PopoverTitle>How the meeting is doing</PopoverTitle>
            <PopoverDescription>
              {SCRIBE_NAME} hears the transcript as it comes and groups it into the topics the
              minutes are built from.
            </PopoverDescription>
          </PopoverHeader>
          <div className="flex flex-col gap-1.5">
            <Detail label="Audio">{audio}</Detail>
            {failed.length > 0 && (
              <Detail label="Failed">
                {failed.map((c) => `Chunk ${c.n}: ${c.error ?? 'failed'}`).join(' · ')}
              </Detail>
            )}
            {lag?.latencyMs !== undefined && (
              <Detail label="Captions">{(lag.latencyMs / 1000).toFixed(1)}s behind</Detail>
            )}
            <Detail label={SCRIBE_NAME}>{DOING[state]}</Detail>
          </div>
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
      {meeting.blocked === 'no-key' && <Badge variant="warning-light">No speech key</Badge>}
      {meeting.blocked === 'bad-key' && (
        <Badge variant="destructive-light">Speech key refused</Badge>
      )}
      {failed.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="destructive-light" tabIndex={0}>
              {failed.length} failed
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            {failed.map((c) => `Chunk ${c.n}: ${c.error ?? 'failed'}`).join(' · ')}
          </TooltipContent>
        </Tooltip>
      )}
      {meeting.scribeUnreachable === true && (
        <Badge variant="warning-light">{SCRIBE_NAME} unreachable</Badge>
      )}
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
