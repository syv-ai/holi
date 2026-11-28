/** The top bar's word on a recording meeting: its timer, and a click
 *  back to it from anywhere. Nothing while nothing records. */
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { Circle } from 'lucide-react'
import { toast } from 'sonner'
import { activeRemoteAtom, StatusBarItem, openVaultAtom, useNow } from '@/plugin-api'
import { clock } from '../shared/scribe-prompt'
import { recorderAtom } from './recorder'
import { openMeetingsAtom, shownMeetingIdAtom } from './state'

function Elapsed({ since }: { since: number }): React.JSX.Element {
  const now = useNow(1000)
  return <span className="tabular-nums">{clock((now - since) / 1000)}</span>
}

export function RecordingStatusItem(): React.JSX.Element | null {
  const rec = useAtomValue(recorderAtom)
  const activeRemote = useAtomValue(activeRemoteAtom)
  const openVault = useSetAtom(openVaultAtom)
  const store = useStore()
  const open = useSetAtom(openMeetingsAtom)
  const show = useSetAtom(shownMeetingIdAtom)
  if (rec.phase === 'idle') return null
  return (
    <StatusBarItem
      tooltip="A meeting is recording. Click to open it"
      label="Recording meeting"
      onClick={() => {
        void (async () => {
          if (rec.remote === null) return
          if (activeRemote !== rec.remote && !(await openVault(rec.remote))) return
          if (store.get(activeRemoteAtom) !== rec.remote || rec.meetingId === null) return
          show(rec.meetingId)
          open()
        })().catch((error: unknown) => {
          toast.error(error instanceof Error ? error.message : String(error))
        })
      }}
    >
      <Circle aria-hidden className="fill-current text-destructive" />
      {rec.startedAt === null ? 'Starting…' : <Elapsed since={rec.startedAt} />}
    </StatusBarItem>
  )
}
