/**
 * The Notifier seam's real adapter: the pure `notificationsFor` decision fed to
 * the background context's native notifications (`AppCtx.notify`). A per-fire
 * spec carries a `task` (its click opens that task); a coalesced summary
 * carries none, since it speaks for several and there is nothing single to open.
 */
import type { AppCtx } from '../../../../main/plugin-api'
import { notificationsFor } from './notifications'
import type { RemindersEvent } from './types'

export function createNotifier(ctx: Pick<AppCtx, 'notify' | 'open'>): {
  fire(event: RemindersEvent): void
} {
  return {
    fire(event) {
      for (const spec of notificationsFor(event)) {
        const task = spec.task
        ctx.notify({
          title: spec.title,
          body: spec.body,
          ...(task === undefined ? {} : { onClick: () => ctx.open(task.remote, task.path) }),
        })
      }
    },
  }
}
