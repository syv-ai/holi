/**
 * The quick agent's global hotkey: written as the glyphs Holi shows a key as
 * (`⌘J`, `⌃⌥Space`), and handed to Electron as an accelerator
 * (`Command+J`). Pure, and shared: the settings row records a key in this
 * form and main registers it.
 *
 * Unlike an in-app hotkey (`lib/hotkey.ts`, where ⌘ and ⌃ both mean the
 * platform key), a global one keeps them apart: ⌘J and ⌃J are different keys
 * to every other app.
 */

/** The default: the key that opens the agents inside Holi. */
export const DEFAULT_QUICK_HOTKEY = '⌘J'

/** The dock's default: the same key with ⌃, which few apps take. */
export const DEFAULT_DOCK_HOTKEY = '⌃⌘J'

/** Modifier glyphs in the order macOS prints them, with Electron's names. */
const MODIFIERS: ReadonlyArray<readonly [string, string]> = [
  ['⌃', 'Control'],
  ['⌥', 'Alt'],
  ['⇧', 'Shift'],
  ['⌘', 'Command'],
]

/** Named keys a global hotkey may end in: Holi writes them as Electron does. */
const NAMED = new Set(['Space', 'Return', 'Tab', 'Up', 'Down', 'Left', 'Right'])

const PUNCTUATION = new Set([',', '.', '/', ';', "'", '[', ']', '\\', '-', '=', '`'])

/** A key Holi registers a global hotkey on: a letter, a digit, F1–F20, a
 *  named key or punctuation, each spelled as Electron spells it. */
const isKey = (key: string): boolean =>
  /^[A-Z0-9]$/.test(key) ||
  /^F([1-9]|1[0-9]|20)$/.test(key) ||
  NAMED.has(key) ||
  PUNCTUATION.has(key)

/** The Electron accelerator for a glyph hotkey, or null when it is not one
 *  Holi registers: at least one of ⌘, ⌃ or ⌥ (a plain letter would be taken
 *  from every app), and one key. */
export function toAccelerator(spec: string): string | null {
  let rest = spec
  const names: string[] = []
  for (const [glyph, name] of MODIFIERS) {
    // In order, each at most once: the form is canonical.
    if (rest.startsWith(glyph)) {
      names.push(name)
      rest = rest.slice(glyph.length)
    }
  }
  if (!names.some((n) => n !== 'Shift') || !isKey(rest)) return null
  return [...names, rest].join('+')
}

/**
 * The glyph hotkey a key press makes, or null while it is only modifiers or
 * not a key Holi registers. Read from `code`, the physical key, so ⌥ (which
 * changes the character) still names the letter.
 */
export function hotkeyFromEvent(e: {
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  code: string
  key: string
}): string | null {
  let key: string | null = null
  const letter = /^Key([A-Z])$/.exec(e.code)
  const digit = /^Digit([0-9])$/.exec(e.code)
  const fn = /^F([0-9]{1,2})$/.exec(e.code)
  if (letter !== null) key = letter[1]!
  else if (digit !== null) key = digit[1]!
  else if (fn !== null) key = `F${fn[1]}`
  else if (e.code === 'Space') key = 'Space'
  else if (e.code === 'Enter') key = 'Return'
  else if (e.code === 'Tab') key = 'Tab'
  else if (e.code.startsWith('Arrow')) key = e.code.slice('Arrow'.length)
  else if (PUNCTUATION.has(e.key)) key = e.key
  if (key === null) return null
  const glyphs =
    (e.ctrlKey ? '⌃' : '') +
    (e.altKey ? '⌥' : '') +
    (e.shiftKey ? '⇧' : '') +
    (e.metaKey ? '⌘' : '')
  const spec = glyphs + key
  return toAccelerator(spec) === null ? null : spec
}
