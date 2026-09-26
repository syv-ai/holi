/**
 * When a message arrived, in the two lengths mail needs. Both always carry the
 * time of day, so two messages an hour apart never look simultaneous.
 *
 * - `listStamp` sits in a narrow column, so it drops what the reader can
 *   infer: "Today", and the current year.
 * - `messageStamp` is read against the thread's other messages, so it is fully
 *   qualified and never relative.
 *
 * An unparseable date is `''`: the sender writes the `Date` header.
 */

function parsed(iso: string): Date | null {
  if (iso === '') return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

function timeOf(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/**
 * A thread row's stamp: `Today 14:22`, `2 Mar 09:15`, `30 Nov 2025 09:15`.
 * `now` is a parameter for tests.
 */
export function listStamp(iso: string, now: Date = new Date()): string {
  const date = parsed(iso)
  if (date === null) return ''

  const time = timeOf(date)
  if (date.toDateString() === now.toDateString()) return `Today ${time}`

  const sameYear = date.getFullYear() === now.getFullYear()
  const day = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
  return `${day} ${time}`
}

/** A message header's stamp: the whole date and the time, always. */
export function messageStamp(iso: string): string {
  const date = parsed(iso)
  if (date === null) return ''
  const day = date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
  return `${day}, ${timeOf(date)}`
}
