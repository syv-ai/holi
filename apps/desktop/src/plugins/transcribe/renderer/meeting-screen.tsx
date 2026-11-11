/**
 * The meeting the tab shows: fetched when opened, then kept current by main's
 * events. While it records it is the live view; once stopped, or opened from
 * the list, it is the review.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useCallback, useEffect, useState } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/composites/empty-state'
import { MeetingReview } from './meeting-review'
import { MeetingView } from './meeting-view'
import { loadMeetingAtom, meetingStatesAtom, message } from './state'
import { useHolis } from './use-holis'

export function MeetingScreen({ meetingId }: { meetingId: string }): React.JSX.Element {
  const meeting = useAtomValue(meetingStatesAtom)[meetingId]
  const load = useSetAtom(loadMeetingAtom)
  const holis = useHolis()
  const [error, setError] = useState<string | null>(null)

  const fetch = useCallback(() => {
    setError(null)
    load(meetingId).catch((e: unknown) => setError(message(e)))
  }, [load, meetingId])
  useEffect(fetch, [fetch])

  if (meeting === undefined) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        {error !== null ? (
          <EmptyState
            role="alert"
            title="This meeting didn’t load"
            description={error}
            action={{ label: 'Retry', onClick: fetch }}
          />
        ) : (
          <div role="status" aria-label="Loading the meeting" className="flex flex-col gap-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}
      </div>
    )
  }

  return meeting.phase === 'recording' ? (
    <MeetingView meeting={meeting} holis={holis} />
  ) : (
    <MeetingReview meeting={meeting} holis={holis} />
  )
}
