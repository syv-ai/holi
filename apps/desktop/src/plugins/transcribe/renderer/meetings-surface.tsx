/**
 * The Meetings app, one of the sidebar's: the recording controls on top,
 * then the meeting being shown (live while it records, its review after), or
 * the list of meetings when none is. Recording lives outside this view (`recorder.ts`), so
 * leaving the tab keeps it going.
 *
 * A meeting opened from the vault's tree is a tab of its own, its folder the
 * tab's id (`meeting-claim.ts`): that meeting alone, with Record while it is
 * not recorded yet and Stop while it records.
 */
import { useAtomValue } from 'jotai'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/composites/empty-state'
import { meetingName } from './meeting-claim'
import { MeetingHeader } from './meeting-header'
import { MeetingScreen } from './meeting-screen'
import { PastMeetings } from './past-meetings'
import { recorderAtom } from './recorder'
import { meetingsAtom, shownMeetingIdAtom } from './state'

export function MeetingsSurface({ id }: { id?: string; visible?: boolean }): React.JSX.Element {
  const shown = useAtomValue(shownMeetingIdAtom)
  // The shell gives a tab opened without an id `id=''` (`tab-view.tsx`): that
  // is the list, not a meeting folder at ''.
  if (id !== undefined && id !== '') return <MeetingFolder path={id} />
  return (
    <div className="flex h-full min-h-0 flex-col">
      <MeetingHeader />
      {shown === null ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="mx-auto max-w-2xl">
            <PastMeetings />
          </div>
        </div>
      ) : (
        <MeetingScreen key={shown} meetingId={shown} />
      )}
    </div>
  )
}

/** The meeting whose folder is `path`: its setup until it records, then the
 *  meeting itself. */
function MeetingFolder({ path }: { path: string }): React.JSX.Element {
  const list = useAtomValue(meetingsAtom)
  const rec = useAtomValue(recorderAtom)
  // A meeting that moved away or was deleted is not this folder's, whatever
  // path its record last had (main follows folders by the id in them).
  const meeting = list?.find((m) => m.folder === path && m.away !== true)
  if (list === null) {
    return (
      <div role="status" aria-label="Loading the meeting" className="flex flex-col gap-2 p-4">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }
  const recordingHere = meeting !== undefined && rec.meetingId === meeting.id
  return (
    <div className="flex h-full min-h-0 flex-col">
      {(meeting === undefined || recordingHere) && (
        <MeetingHeader path={path} {...(meeting === undefined ? {} : { meetingId: meeting.id })} />
      )}
      {meeting === undefined ? (
        <div className="mx-auto w-full max-w-2xl px-4 py-6">
          <EmptyState
            title={`${meetingName(path)} is not recorded yet`}
            description="Press Record when the meeting starts. Its transcript, topics and minutes are kept in this folder."
          />
        </div>
      ) : (
        <MeetingScreen key={meeting.id} meetingId={meeting.id} />
      )}
    </div>
  )
}
