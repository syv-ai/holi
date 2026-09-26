/**
 * A hotkey is written as the glyph string a tooltip shows (`⌘J`, `⌘⇧D`), so
 * the same string displays and binds it.
 *
 * `⌘` (and `⌃`) mean the platform modifier (`metaKey || ctrlKey`); `⇧` shift,
 * `⌥` alt; the trailing character is the key. Modifiers match exactly: `⌘J`
 * does not fire on ⌘⇧J.
 */
export interface ParsedHotkey {
  mod: boolean
  shift: boolean
  alt: boolean
  key: string
}

export function parseHotkey(spec: string): ParsedHotkey {
  let mod = false
  let shift = false
  let alt = false
  let key = ''
  for (const ch of spec) {
    if (ch === '⌘' || ch === '⌃') mod = true
    else if (ch === '⇧') shift = true
    else if (ch === '⌥') alt = true
    else key += ch
  }
  return { mod, shift, alt, key: key.toLowerCase() }
}

export function matchHotkey(e: KeyboardEvent, spec: string): boolean {
  const p = parseHotkey(spec)
  if (p.mod !== (e.metaKey || e.ctrlKey)) return false
  if (p.shift !== e.shiftKey) return false
  if (p.alt !== e.altKey) return false
  if (e.key.toLowerCase() === p.key) return true
  // ⌥ changes the character, not the key: on macOS `e.key` for ⌥⌘S is `ß`.
  // With ⌥ in the spec, a letter or digit falls back to the physical key. Only
  // then: on layouts like AZERTY the physical key and the letter differ, and
  // without ⌥ the letter is what is meant.
  if (!p.alt) return false
  if (/^[a-z]$/.test(p.key)) return e.code === `Key${p.key.toUpperCase()}`
  if (/^[0-9]$/.test(p.key)) return e.code === `Digit${p.key}`
  return false
}
