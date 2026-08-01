/**
 * A hotkey is written the way it reads on screen — the glyph string a tooltip
 * shows, e.g. `⌘J`, `⌘⇧D`. The same string both DISPLAYS the shortcut and BINDS
 * it, so a control declares its key once (see PanelHeader's HeaderAction.hotkey).
 *
 * `⌘` (and `⌃`) mean "the platform modifier" — Meta on macOS, Control elsewhere —
 * matching the app's `metaKey || ctrlKey` convention; `⇧` shift, `⌥` alt. The
 * trailing character is the key. Matching is exact on the modifiers named: `⌘J`
 * fires on ⌘/Ctrl+J only, not ⌘⇧J.
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
  return e.key.toLowerCase() === p.key
}
