/**
 * The app's clock: the current local minute, and the day it falls on.
 *
 * Read by the task board (overdue labels, date presets), the frontmatter
 * widget and the daily note. Ticked once, from the Shell.
 */
import { stampDate } from '@holi/shared'
import { atom } from 'jotai'

/** The current local minute, as `YYYY-MM-DDTHH:MM`. */
function localNow(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

/**
 * Now, to the minute, as `YYYY-MM-DDTHH:MM`.
 *
 * Held in state rather than read inline so the label rules stay pure and
 * testable, and the board re-renders when the clock moves. Local, not UTC: the
 * same frame the roll-forward uses.
 *
 * **Minute-valued on purpose.** A due date may name an hour, so `overdue` turns
 * over on a minute, but the atom's identity changes only when the minute
 * string does, so a timer that fires twice a minute re-renders nothing.
 */
export const nowAtom = atom<string>(localNow())

/** Today, as `YYYY-MM-DD`: derived, so the daily note and the labels can never
 *  disagree about what day it is. */
export const todayAtom = atom((get) => stampDate(get(nowAtom)) ?? get(nowAtom).slice(0, 10))

/** Advance `nowAtom` to the current minute. Mounted once, from the Shell. */
export const tickNowAtom = atom(null, (get, set) => {
  const next = localNow()
  if (next !== get(nowAtom)) set(nowAtom, next)
})
