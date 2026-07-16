/** Mirrors the server bus's RemindersEvent shape (apps/server/src/bus.ts), the same way
 * vault-manager mirrors TasksEvent — the bus types are server-internal; @holi/shared is
 * the client↔server seam. */

export interface ReminderFire {
  taskId: string
  /** The task's title — what the notification is actually about. */
  title: string
  /** Scheduled *local wall-clock* time, for display only. Not an instant. */
  fireAt: string
}

export interface RemindersEvent {
  fires: ReminderFire[]
  /** The server fired more at once than is worth showing one-by-one. */
  coalesced: boolean
  /** The batch's fire instant (ISO UTC). The server's delivery watermark runs on this;
   * the client only passes it through. */
  firedAt: string
}
