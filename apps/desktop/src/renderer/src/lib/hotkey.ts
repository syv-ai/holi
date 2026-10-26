/**
 * A hotkey is written as the glyph string a tooltip shows (`⌘J`, `⌘⇧D`), so
 * the same string displays and binds it.
 *
 * `⌘` (and `⌃`) mean the platform modifier (`metaKey || ctrlKey`); `⇧` shift,
 * `⌥` alt; the trailing character is the key. Modifiers match exactly: `⌘J`
 * does not fire on ⌘⇧J.
 */
interface ParsedHotkey {
  mod: boolean
  shift: boolean
  alt: boolean
  key: string
}

/** @public exported for its test */
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

/** Glyphs a spec may name a non-character key by. */
const KEY_ALIASES: Record<string, string> = {
  '←': 'arrowleft',
  '→': 'arrowright',
  '↑': 'arrowup',
  '↓': 'arrowdown',
}

/**
 * The stricter match the shell's shortcut table uses (`lib/shortcuts.ts`).
 *
 * On a Mac the glyphs mean the keys they draw: `⌘` is Command only and `⌃`
 * Control only, so Control's text-editing keys (⌃B, ⌃K, ⌃N in any field, and
 * every control key in the terminal) are never taken for a ⌘ shortcut.
 * Elsewhere both glyphs are Ctrl, and a held Windows key matches nothing.
 *
 * A symbol key ignores Shift unless the spec names it: `?` is Shift-/ on one
 * layout and a plain key on another, and the character is what is meant.
 * Arrows are written `←→↑↓`; named keys as their `KeyboardEvent.key`
 * (`Tab`, `F2`).
 */
export function matchShortcutKey(e: KeyboardEvent, spec: string, mac: boolean): boolean {
  const p = parseHotkey(spec)
  const key = KEY_ALIASES[p.key] ?? p.key
  if (mac) {
    if (e.metaKey !== spec.includes('⌘')) return false
    if (e.ctrlKey !== spec.includes('⌃')) return false
  } else {
    if (e.metaKey || e.ctrlKey !== p.mod) return false
  }
  if (e.altKey !== p.alt) return false
  const symbol = key.length === 1 && !/[a-z0-9]/.test(key)
  if (symbol ? p.shift && !e.shiftKey : e.shiftKey !== p.shift) return false
  if (e.key.toLowerCase() === key) return true
  // ⌥ changes the character, not the key (⌥⌘W is `∑`): fall back to the
  // physical key, as `matchHotkey` does.
  if (!p.alt) return false
  if (/^[a-z]$/.test(key)) return e.code === `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return e.code === `Digit${key}`
  return false
}

const MAC_ORDER = ['⌃', '⌥', '⇧', '⌘']
const PC_NAMES: Record<string, string> = { '⌘': 'Ctrl', '⌃': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift' }
const PC_ORDER = ['Ctrl', 'Alt', 'Shift']

/**
 * The keys of a spec as one label per key cap, in the platform's order: Apple's
 * `⌃⌥⇧⌘` glyphs on a Mac, `Ctrl Alt Shift` words elsewhere.
 */
export function hotkeyLabels(spec: string, mac: boolean): string[] {
  const mods: string[] = []
  let key = ''
  for (const ch of spec) {
    if (ch in PC_NAMES) mods.push(ch)
    else key += ch
  }
  const label = key.length === 1 ? key.toUpperCase() : key
  if (mac) {
    const sorted = MAC_ORDER.filter((m) => mods.includes(m))
    return [...sorted, label]
  }
  const names = [...new Set(mods.map((m) => PC_NAMES[m]))]
  return [...PC_ORDER.filter((n) => names.includes(n)), label]
}
