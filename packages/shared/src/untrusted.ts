/**
 * Text from outside the vault owner's control (a mail, an invite), fenced
 * before it reaches the agent, so it reads as data and never as an
 * instruction from the person (docs/features/google.md).
 *
 * The fence is a tag the shipped skills name, carrying a random id in both its
 * opening and its closing tag: whatever sits between `<untrusted id="X" ...>`
 * and `</untrusted id="X">` is something somebody else wrote. The id is what
 * makes it a fence: the text was written before the id existed, so it cannot
 * close the fence with the right one, however it spells a lookalike (zero-width
 * characters, full-width brackets, Cyrillic letters). As a second layer, any
 * `<untrusted` or `</untrusted` inside the text, however spaced or cased, loses
 * its `<`.
 *
 * Pure and browser-safe (`globalThis.crypto`): main fences what `holi google`
 * prints, and the renderer what it writes into a seeded prompt.
 */

export const UNTRUSTED_TAG = 'untrusted'

/** Where fenced text came from: the agent may weigh a mail, an invite and a
 *  web page differently, and the skills name each. */
export type UntrustedSource = 'mail' | 'calendar' | 'web'

/** Any opening or closing fence tag, spaced or cased however. */
const MARKER = /<(\s*\/?\s*untrusted)/gi

/** An attribute value that cannot end its own quotes or tag. */
const attribute = (value: string): string => value.replace(/["<>\r\n]/g, '').trim()

/** A fresh fence id: 8 random bytes as hex, unguessable by the text it fences. */
function fenceId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * `text` inside an `untrusted` fence with a fresh `id`, naming its `source`
 * and any further attributes (`from`: the sender's address). An empty text
 * stays empty: there is nothing in it to mistake for an instruction.
 */
export function fenceUntrusted(
  text: string,
  source: UntrustedSource,
  attrs: Record<string, string> = {},
): string {
  if (text === '') return text
  const id = fenceId()
  const named = Object.entries(attrs)
    .map(([key, value]) => [key, attribute(value)] as const)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => ` ${key}="${value}"`)
    .join('')
  const body = text.replace(MARKER, '&lt;$1')
  return `<${UNTRUSTED_TAG} id="${id}" source="${source}"${named}>${body}</${UNTRUSTED_TAG} id="${id}">`
}
