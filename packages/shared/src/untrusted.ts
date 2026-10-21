/**
 * Text from outside the vault owner's control (a mail, an invite), fenced
 * before it reaches the agent, so it reads as data and never as an
 * instruction from the person (docs/features/google.md).
 *
 * The fence is a tag the shipped skills name: whatever sits between
 * `<untrusted ...>` and `</untrusted>` is something somebody else wrote. A
 * fence the text could close itself would be no fence, so any `<untrusted` or
 * `</untrusted` inside it, however spaced or cased, loses its `<`: what the
 * agent sees as the closing marker is always the one this function wrote.
 *
 * Pure and browser-safe: main fences what `holi google` prints, and the
 * renderer what it writes into a seeded prompt.
 */

export const UNTRUSTED_TAG = 'untrusted'

/** Where fenced text came from: the agent may weigh a mail and an invite
 *  differently, and the skills name both. */
export type UntrustedSource = 'mail' | 'calendar'

/** Any opening or closing fence tag, spaced or cased however. */
const MARKER = /<(\s*\/?\s*untrusted)/gi

/** An attribute value that cannot end its own quotes or tag. */
const attribute = (value: string): string => value.replace(/["<>\r\n]/g, '').trim()

/**
 * `text` inside an `untrusted` fence naming its `source` and any further
 * attributes (`from`: the sender's address). An empty text stays empty: there
 * is nothing in it to mistake for an instruction.
 */
export function fenceUntrusted(
  text: string,
  source: UntrustedSource,
  attrs: Record<string, string> = {},
): string {
  if (text === '') return text
  const named = Object.entries(attrs)
    .map(([key, value]) => [key, attribute(value)] as const)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => ` ${key}="${value}"`)
    .join('')
  const body = text.replace(MARKER, '&lt;$1')
  return `<${UNTRUSTED_TAG} source="${source}"${named}>${body}</${UNTRUSTED_TAG}>`
}
