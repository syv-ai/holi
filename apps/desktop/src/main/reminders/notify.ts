/**
 * The Notifier seam's real adapter: the pure `notificationsFor` decision fed to
 * Holi's native notifications (`../notifications.ts`). A per-fire spec carries
 * a `task` (its click opens that task via `onClick`); a coalesced summary
 * carries none, since it speaks for several and there is nothing single to open.
 */
import { showNotification } from '../notifications'
import { notificationsFor } from './notifications'
import type { RemindersEvent } from './types'

export function createNotifier(onClick: (remote: string, path: string) => void): {
  fire(event: RemindersEvent): void
} {
  return {
    fire(event) {
      for (const spec of notificationsFor(event)) {
        const task = spec.task
        showNotification({
          title: spec.title,
          body: spec.body,
          ...(task === undefined ? {} : { onClick: () => onClick(task.remote, task.path) }),
        })
      }
    },
  }
}
