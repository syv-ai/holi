/**
 * What to put on screen when reminders fire: the pure half (decide here, let the
 * adapter own Electron).
 *
 * `sweep` decides *when*; this decides *how many notifications that costs*. Those
 * are different questions, which is why `coalesced` rides the event.
 */
import type { RemindersEvent } from './types'

/** How many titles a summary names before it gives up and counts. */
const SUMMARY_TITLES = 3

export interface NotificationSpec {
  title: string
  body: string
  /** Clicking opens this task. Absent on a summary — it speaks for several. */
  task?: { remote: string; path: string }
}

const when = (fireAt: string) => fireAt.replace('T', ' ')

export function notificationsFor(event: RemindersEvent): NotificationSpec[] {
  if (event.fires.length === 0) return []

  // Above the evaluator's threshold, one notification instead of N: a wall of
  // toasts gets dismissed without reading.
  if (event.coalesced) {
    const named = event.fires.slice(0, SUMMARY_TITLES).map((f) => f.title)
    const rest = event.fires.length - named.length
    return [
      {
        title: `${event.fires.length} reminders`,
        body: rest > 0 ? `${named.join(', ')} +${rest} more` : named.join(', '),
      },
    ]
  }

  return event.fires.map((f) => ({
    title: f.title,
    body: `Reminder · ${when(f.fireAt)}`,
    task: { remote: f.remote, path: f.path },
  }))
}
