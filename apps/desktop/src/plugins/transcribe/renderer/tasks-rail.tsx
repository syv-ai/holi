/**
 * The meeting's Tasks: what people sent from it, or made and have not sent
 * yet, as rows (`task-row.tsx`), oldest first. Hviske's suggestions live in
 * their topics until someone sends one. Custom range makes a task from a
 * stretch of the meeting that is not one topic (`custom-range-dialog.tsx`).
 */
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { Card, MeetingState } from '../shared/meeting'
import { useAgentName } from './agent-name'
import { CustomRangeDialog } from './custom-range-dialog'
import { TASKS_NAME } from './names'
import { TaskRow } from './task-row'

/** Custom range, and the dialog it opens. */
function CustomRangeButton({ meeting }: { meeting: MeetingState }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        disabled={meeting.segments.length === 0}
        onClick={() => setOpen(true)}
      >
        <Plus aria-hidden />
        Custom range
      </Button>
      <CustomRangeDialog meeting={meeting} open={open} onOpenChange={setOpen} />
    </>
  )
}

/** The tasks the rail lists: sent, or made and kept, not dismissed. */
const tasksOf = (meeting: MeetingState): Card[] =>
  meeting.cards
    .filter((c) => c.status === 'building' || c.status === 'accepted')
    .sort((a, b) => a.createdAt - b.createdAt)

export function TasksRail({ meeting }: { meeting: MeetingState }): React.JSX.Element {
  const tasks = tasksOf(meeting)
  const agent = useAgentName()
  return (
    <section aria-label={TASKS_NAME} className="flex flex-col gap-2">
      <div className="flex items-center gap-2 ps-2">
        <h2 className="text-xs font-medium text-muted-foreground">{TASKS_NAME}</h2>
        {tasks.length > 0 && (
          <span className="text-xs text-muted-foreground tabular-nums">{tasks.length}</span>
        )}
        <div className="ms-auto">
          <CustomRangeButton meeting={meeting} />
        </div>
      </div>
      {tasks.length === 0 ? (
        <p className="px-2 text-sm text-muted-foreground">Send a topic to {agent} to start.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-divider">
          {tasks.map((c) => (
            <li key={c.id}>
              <TaskRow meeting={meeting} card={c} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
