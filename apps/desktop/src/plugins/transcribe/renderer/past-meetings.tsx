/** Every meeting in the vault, newest first; one opens with its minutes,
 *  transcript and tasks, which stay actionable after the meeting. Each has
 *  a menu, on hover or focus, to rename or delete it (`meeting-actions.tsx`). */
import { useAtomValue, useSetAtom } from 'jotai'
import { AudioLines } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/composites/empty-state'
import type { MeetingPhase } from '../shared/meeting'
import { MeetingMenu, TitleEditor } from './meeting-actions'
import { TASK_NAME, TASKS_NAME } from './names'
import { loadMeetingsAtom, meetingsAtom, meetingsErrorAtom, shownMeetingIdAtom } from './state'

/** The phases worth a word beside a meeting's title. */
const PHASE_BADGE: Partial<Record<MeetingPhase, string>> = {
  recording: 'Recording',
  finishing: 'Finishing',
  failed: 'Failed',
}

const stamp = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

export function PastMeetings(): React.JSX.Element {
  const meetings = useAtomValue(meetingsAtom)
  const error = useAtomValue(meetingsErrorAtom)
  const reload = useSetAtom(loadMeetingsAtom)
  const open = useSetAtom(shownMeetingIdAtom)
  const [renaming, setRenaming] = useState<string | null>(null)

  if (error !== null && meetings === null) {
    return (
      <EmptyState
        role="alert"
        title="The meetings didn’t load"
        description={error}
        action={{ label: 'Retry', onClick: () => void reload() }}
      />
    )
  }
  if (meetings === null) {
    return (
      <div role="status" aria-label="Loading meetings" className="flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )
  }
  if (meetings.length === 0) {
    return (
      <EmptyState
        icon={AudioLines}
        title="No meetings yet"
        description="Pick a profile and press Record when the call starts."
      />
    )
  }
  return (
    <section aria-label="Past meetings" className="flex flex-col gap-1">
      <h2 className="px-2 text-xs font-medium text-muted-foreground">Meetings</h2>
      <ul className="flex flex-col divide-y divide-divider">
        {meetings.map((m) => (
          <li key={m.id} className="group/meeting flex items-center gap-1">
            {renaming === m.id ? (
              <div className="flex min-w-0 flex-1 px-1 py-1">
                <TitleEditor meeting={m} onDone={() => setRenaming(null)} />
              </div>
            ) : (
              <Button
                variant="ghost"
                size="row"
                className="min-w-0 flex-1"
                onClick={() => open(m.id)}
              >
                <span className="min-w-0 flex-1 truncate text-sm">{m.title}</span>
                {PHASE_BADGE[m.phase] !== undefined && (
                  <Badge variant={m.phase === 'finishing' ? 'secondary' : 'destructive-light'}>
                    {PHASE_BADGE[m.phase]}
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground tabular-nums">
                  {m.cards} {m.cards === 1 ? TASK_NAME : TASKS_NAME}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {stamp.format(new Date(m.startedAt))}
                </span>
              </Button>
            )}
            <span className="shrink-0 opacity-0 motion-respond group-focus-within/meeting:opacity-100 group-hover/meeting:opacity-100 has-data-[state=open]:opacity-100">
              <MeetingMenu meeting={m} onRename={() => setRenaming(m.id)} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
