/**
 * Holi's one way to put a native notification on screen: the reminders'
 * notifier and the plugins' `notify` (`plugin-api.ts`) both come through here.
 *
 * **Retain each live `Notification` until macOS is done with it.** One dropped
 * from scope before it is presented can be garbage-collected and then silently
 * never appears, a documented Electron gotcha, and the reason a `.show()` in a
 * loop over locals can fire without a banner. A reference is held from
 * `show()` until the OS reports it closed, clicked or failed.
 */
import { Notification } from 'electron'

export interface NativeNotice {
  title: string
  body: string
  /** Runs when the person clicks it. */
  onClick?: () => void
}

const live = new Set<Notification>()

export function showNotification({ title, body, onClick }: NativeNotice): void {
  const n = new Notification({ title, body })
  if (onClick !== undefined) n.on('click', onClick)
  live.add(n)
  const release = (): void => void live.delete(n)
  n.on('close', release)
  n.on('click', release)
  n.on('failed', release)
  n.show()
}
