/**
 * The last leg: a fired reminder becomes a notification you can actually see.
 *
 * Main-side because `Notification` is a main-process API and main already owns the SSE
 * connection the fires arrive on. The decision of *what* to show is pure and lives in
 * `notifications.ts`; this only presents it and routes the click.
 *
 * Every fire now carries the vault it came from, because the stream is user-scoped and
 * they arrive for vaults you do not have open (D48 is closed; D52). Without it the click
 * would set a task id against whatever vault happened to be on screen and silently select
 * nothing — a notification you cannot act on, which is worse than one you never got.
 */
import { Notification, type BrowserWindow } from 'electron'
import { notificationsFor } from './notifications'
import type { RemindersEvent } from './types'

export interface ReminderNotifierDeps {
  getWindow: () => BrowserWindow | null
  send: (channel: string, payload: unknown) => void
}

export function createReminderNotifier(deps: ReminderNotifierDeps) {
  return {
    raise(vaultId: string, event: RemindersEvent): void {
      // Headless runs (CI, a probe) and desktops without a notification service must not
      // throw here: this is called straight from the SSE handler, and an exception would
      // take the stream — docs, tasks, presence and all — down with it.
      if (!Notification.isSupported()) return
      const specs = notificationsFor(event)
      // Worth a line: a reminder that never appears is otherwise indistinguishable from
      // one that never fired, and the OS can suppress a notification we raised correctly.
      if (specs.length > 0) console.log(`[reminders] raising ${specs.length} notification(s)`)
      for (const spec of specs) {
        const notification = new Notification({ title: spec.title, body: spec.body })
        notification.on('click', () => {
          const win = deps.getWindow()
          if (win) {
            if (win.isMinimized()) win.restore()
            win.focus()
          }
          // A summary speaks for several tasks, so it carries no taskId — but it still
          // carries the vault, so the click can land you in the right one.
          deps.send('reminders:open', { vaultId, taskId: spec.taskId ?? null })
        })
        notification.show()
      }
    },
  }
}
