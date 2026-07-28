/** The reminder event, produced locally by `sweep` (apps/desktop/src/main/reminders/sweep.ts).
 * Tasks are identified by their vault `remote` + file `path` — the one identity vocabulary
 * that carries file → notification → click, with no `taskId` residue from the deleted server bus. */

export interface ReminderFire {
  /** The owning vault, `owner/repo`. */
  remote: string
  /** The task file's vault-relative path — its identity, and what a click opens. */
  path: string
  /** The task's title — what the notification is actually about. */
  title: string
  /** Scheduled *local wall-clock* time, for display only. Not an instant. */
  fireAt: string
}

export interface RemindersEvent {
  fires: ReminderFire[]
  /** More fired at once than is worth showing one-by-one — collapse to a summary. */
  coalesced: boolean
  /** The sweep's fire moment (local wall-clock `YYYY-MM-DDTHH:MM`), passed through for display. */
  firedAt: string
}
