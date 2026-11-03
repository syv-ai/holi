/** The status bar's word on a recording meeting: its timer, and a click
 *  back to it from anywhere. Nothing while nothing records. */
import { useAtomValue, useSetAtom } from 'jotai'
import { Circle } from 'lucide-react'
import { openSurfaceAtom, StatusBarItem, useNow } from '@/plugin-api'
import { clock } from './format'
import { recorderAtom } from './recorder'
import { MEETINGS_SURFACE, shownMeetingIdAtom } from './state'

function Elapsed({ since }: { since: number }): React.JSX.Element {
  const now = useNow(1000)
  return <span className="tabular-nums">{clock((now - since) / 1000)}</span>
}

export function RecordingStatusItem(): React.JSX.Element | null {
  const rec = useAtomValue(recorderAtom)
  const open = useSetAtom(openSurfaceAtom)
  const show = useSetAtom(shownMeetingIdAtom)
  if (rec.phase === 'idle') return null
  return (
    <StatusBarItem
      tooltip="A meeting is recording. Click to open it"
      label="Recording meeting"
      onClick={() => {
        if (rec.meetingId !== null) show(rec.meetingId)
        open(MEETINGS_SURFACE)
      }}
    >
      <Circle aria-hidden className="fill-current text-destructive" />
      {rec.startedAt === null ? 'Starting…' : <Elapsed since={rec.startedAt} />}
    </StatusBarItem>
  )
}
