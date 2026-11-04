/**
 * What to put on screen when reminders fire: the pure half (decide here, let the
 * adapter own Electron).
 *
 * `sweep` decides *when*; this decides *how many notifications that costs*. Those
 * are different questions, which is why `coalesced` rides the event.
 */
import type { ReminderFire, RemindersEvent } from './types'

/** How many titles a summary names before it gives up and counts. */
const SUMMARY_TITLES = 3

export interface NotificationSpec {
  title: string
  body: string
  /** Clicking opens this task. Absent on a summary — it speaks for several. */
  task?: { remote: string; path: string }
}

const when = (fireAt: string) => fireAt.replace('T', ' ')

/** The vault as the vault switcher names it: the repo of `owner/repo`. */
const vaultName = (remote: string) => remote.slice(remote.indexOf('/') + 1)

const single = (f: ReminderFire): NotificationSpec => ({
  title: f.title,
  body: `${vaultName(f.remote)} · Reminder · ${when(f.fireAt)}`,
  task: { remote: f.remote, path: f.path },
})

/**
 * Every notification names the vault its task is in: reminders come from
 * every registered vault, open or not, and one must never read as another's.
 * A summary never spans vaults either: a coalesced sweep gives each vault its
 * own, and a vault with a single fire keeps the notification that opens it.
 */
export function notificationsFor(event: RemindersEvent): NotificationSpec[] {
  if (event.fires.length === 0) return []

  // Above the evaluator's threshold, fewer notifications than fires: a wall of
  // toasts gets dismissed without reading.
  if (!event.coalesced) return event.fires.map(single)

  const byVault = new Map<string, ReminderFire[]>()
  for (const f of event.fires) byVault.set(f.remote, [...(byVault.get(f.remote) ?? []), f])
  return [...byVault].map(([remote, fires]) => {
    if (fires.length === 1) return single(fires[0]!)
    const named = fires.slice(0, SUMMARY_TITLES).map((f) => f.title)
    const rest = fires.length - named.length
    return {
      title: `${fires.length} reminders in ${vaultName(remote)}`,
      body: rest > 0 ? `${named.join(', ')} +${rest} more` : named.join(', '),
    }
  })
}
