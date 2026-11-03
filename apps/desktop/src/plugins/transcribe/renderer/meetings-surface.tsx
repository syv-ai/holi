/**
 * The Meetings tab: the recording controls on top, then the meeting being
 * shown (live while it records, its review after), or the list of meetings
 * when none is. Recording lives outside this view (`recorder.ts`), so
 * leaving the tab keeps it going.
 */
import { useAtomValue } from 'jotai'
import { MeetingHeader } from './meeting-header'
import { MeetingScreen } from './meeting-screen'
import { PastMeetings } from './past-meetings'
import { shownMeetingIdAtom } from './state'

export function MeetingsSurface(): React.JSX.Element {
  const shown = useAtomValue(shownMeetingIdAtom)
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
