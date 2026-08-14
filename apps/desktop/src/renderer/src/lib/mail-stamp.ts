/**
 * When a message arrived, in the two lengths mail needs.
 *
 * There used to be two `shortDate` functions — one in `MailView`, one in
 * `DraftsList` — and both showed the day OR the time, never both: a time for
 * things that arrived today, a bare date for everything else. That is the
 * standard mail-list compression and it loses the one thing a reader scanning a
 * thread actually wants, which is *when in the day* something landed. Two
 * messages an hour apart looked simultaneous.
 *
 * So both lengths now say both, and the difference between them is how much
 * room they have:
 *
 * - `listStamp` sits in a 320px column that narrows to 220px, so it drops
 *   everything the reader can infer. Today is "Today"; this year omits the year.
 * - `messageStamp` sits in the reader, has the width, and is read *against the
 *   other messages in the thread* — so it is fully qualified and never relative.
 *   "Today" inside a thread is a word you have to resolve against a date you
 *   cannot see.
 *
 * **`now` is a parameter**, so a test does not depend on the clock. It defaults,
 * because every caller in the app means "now".
 *
 * **An unparseable date is `''`.** `DraftsList` guarded this and `MailView` did
 * not, which is the kind of split that only shows up as `Invalid Date` in front
 * of a user. A `Date` header is written by the sender and can hold anything.
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
 *
 * The year appears only when it differs from the current one — in a mailbox,
 * "this year" is the overwhelming default and printing it on every row spends
 * four characters of a narrow column on nothing.
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
