/**
 * The Notifier seam's real adapter — the pure `notificationsFor` decision fed to
 * Electron's `Notification`. A per-fire spec carries a `task` (its click opens
 * that task via `onClick`); a coalesced summary carries none — it speaks for
 * several, so there is nothing single to open.
 */
import { Notification } from 'electron'
import { notificationsFor } from './notifications'
import type { RemindersEvent } from './types'

/**
 * Retain each live `Notification` until macOS is done with it. A `Notification`
 * dropped from scope before it is presented can be garbage-collected and then
 * silently never appears — a documented Electron gotcha, and the reason a
 * `.show()` in a loop over locals can fire without a banner. We hold a reference
 * from `show()` until the OS reports it closed/clicked/failed.
 */
const live = new Set<Notification>()

export function createNotifier(onClick: (remote: string, path: string) => void): {
  fire(event: RemindersEvent): void
} {
  return {
    fire(event) {
      for (const spec of notificationsFor(event)) {
        const n = new Notification({ title: spec.title, body: spec.body })
        if (spec.task) {
          const { remote, path } = spec.task
          n.on('click', () => onClick(remote, path))
        }
        live.add(n)
        const release = (): void => void live.delete(n)
        n.on('close', release)
        n.on('click', release)
        n.on('failed', release)
        n.show()
      }
    },
  }
}
