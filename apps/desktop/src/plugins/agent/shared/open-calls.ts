/**
 * The calls a session's current turn has made and has no result for, by id,
 * oldest first: what a permission prompt can be about. Pure, for both sides.
 *
 * Read from the conversation (main's entries, a call and its result apart, or
 * the chat's items, the result folded into its call). Only the current turn
 * counts: a person's message, a turn's end or an interrupt starts over, so a
 * call an older turn left without a result is never taken for the one asked
 * about now. A message typed while the agent works (`queued`) is not a new
 * turn.
 */
interface Entry {
  kind: string
  id: string
  /** A chat item's folded result. */
  result?: unknown
  queued?: boolean
}

export function openCalls(entries: readonly Entry[]): string[] {
  let open: string[] = []
  for (const e of entries) {
    if (
      (e.kind === 'user' && e.queued !== true) ||
      e.kind === 'turn-end' ||
      e.kind === 'interrupt'
    ) {
      open = []
    } else if (e.kind === 'tool' && e.result === undefined) {
      open.push(e.id)
    } else if (e.kind === 'tool-result') {
      open = open.filter((id) => id !== e.id)
    }
  }
  return open
}

/** The one call a prompt is about, or null when there is none or more than
 *  one: then nothing can say which the prompt is, and Holi does not answer it. */
export function soleOpenCall(entries: readonly Entry[]): string | null {
  const open = openCalls(entries)
  return open.length === 1 ? open[0]! : null
}
