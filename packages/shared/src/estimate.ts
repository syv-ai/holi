/**
 * A task's `estimate`: how much work it is, as a number and a unit
 * (`30m`, `2h`, `1.5d`, `1w`). Written by people, so it stays the words they
 * wrote; the minutes are only for adding estimates up.
 *
 * A day is a working day (8 hours) and a week five of them, the way a team
 * means "two days of work", not 48 hours.
 */

const ESTIMATE = /^(\d+(?:\.\d+)?)(m|h|d|w)$/

const MINUTES: Record<string, number> = { m: 1, h: 60, d: 8 * 60, w: 5 * 8 * 60 }

/** Whether `value` is an estimate as the file spells one. */
export function isEstimate(value: string): boolean {
  const match = ESTIMATE.exec(value)
  return match !== null && Number(match[1]) > 0
}

/** The work an estimate stands for, in minutes, or null for anything else. */
export function estimateMinutes(value: string | undefined): number | null {
  if (value === undefined) return null
  const match = ESTIMATE.exec(value)
  if (match === null) return null
  const amount = Number(match[1])
  return amount > 0 ? amount * MINUTES[match[2]!]! : null
}

/** Minutes as the largest whole unit that reads well: `90` → `1.5h`. */
export function formatEstimate(minutes: number): string {
  const units: [string, number][] = [
    ['w', MINUTES.w!],
    ['d', MINUTES.d!],
    ['h', MINUTES.h!],
  ]
  for (const [unit, size] of units) {
    if (minutes >= size) return `${Math.round((minutes / size) * 10) / 10}${unit}`
  }
  return `${Math.round(minutes)}m`
}
