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

/** Keys a global hotkey may end in, by the name Holi writes, with Electron's. */
const NAMED: Readonly<Record<string, string>> = {
  Space: 'Space',
  Return: 'Return',
  Tab: 'Tab',
  Up: 'Up',
  Down: 'Down',
  Left: 'Left',
  Right: 'Right',
}

const PUNCTUATION = new Set([',', '.', '/', ';', "'", '[', ']', '\\', '-', '=', '`'])

/** The parts of a glyph hotkey, or null when it is not one Holi registers: at
 *  least one of ⌘, ⌃ or ⌥ (a plain letter would be taken from every app), and
 *  one key. */
export function parseGlobalHotkey(
  spec: string,
): { modifiers: string[]; key: string; accelerator: string } | null {
  let rest = spec
  const modifiers: string[] = []
  for (const [glyph] of MODIFIERS) {
    // In order, each at most once: the form is canonical.
    if (rest.startsWith(glyph)) {
      modifiers.push(glyph)
      rest = rest.slice(glyph.length)
    }
  }
  if (!modifiers.some((m) => m === '⌘' || m === '⌃' || m === '⌥')) return null
  let key: string | null = null
  let electronKey: string | null = null
  if (/^[A-Z0-9]$/.test(rest)) {
    key = rest
    electronKey = rest
  } else if (/^F([1-9]|1[0-9]|20)$/.test(rest)) {
    key = rest
    electronKey = rest
  } else if (NAMED[rest] !== undefined) {
    key = rest
    electronKey = NAMED[rest]!
  } else if (PUNCTUATION.has(rest)) {
    key = rest
    electronKey = rest
  }
  if (key === null || electronKey === null) return null
  const names = MODIFIERS.filter(([g]) => modifiers.includes(g)).map(([, name]) => name)
  return { modifiers, key, accelerator: [...names, electronKey].join('+') }
}

/** The Electron accelerator for a glyph hotkey, or null for one Holi does not
 *  register. */
export function toAccelerator(spec: string): string | null {
  return parseGlobalHotkey(spec)?.accelerator ?? null
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
  return parseGlobalHotkey(spec) === null ? null : spec
}
