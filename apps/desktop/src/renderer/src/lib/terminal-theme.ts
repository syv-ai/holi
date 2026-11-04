/**
 * The bottom panel's xterm theme, read from the app's CSS tokens
 * (`--terminal-*`, `--foreground`, `--background` in `index.css`), so a
 * terminal follows light and dark and a vault's theme like the rest of the
 * window. Read again when the mode swaps.
 */
import type { ITheme } from '@xterm/xterm'

/** xterm's 16 ANSI slots, and the token each is read from. */
const ANSI = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const

const tokenOf = (slot: string) =>
  `--terminal-${slot.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`

let probe: CanvasRenderingContext2D | null | undefined

/**
 * A CSS colour as `#rrggbbaa`: xterm parses hex and rgb() but not the
 * oklch the tokens are written in, so the browser paints one pixel of it and
 * reads it back. Null when there is no canvas (tests) or no colour.
 */
function toHex(color: string): string | null {
  if (color.trim() === '') return null
  if (probe === undefined) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    try {
      probe = canvas.getContext('2d', { willReadFrequently: true })
    } catch {
      probe = null
    }
  }
  if (probe === null) return null
  probe.clearRect(0, 0, 1, 1)
  probe.fillStyle = '#00000000'
  probe.fillStyle = color
  probe.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data
  const hex = (n: number | undefined) => (n ?? 0).toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}${hex(a)}`
}

/** The theme for an xterm mounted in `mount`. */
export function terminalTheme(mount: HTMLElement): ITheme {
  const style = getComputedStyle(mount)
  const token = (name: string) => toHex(style.getPropertyValue(name)) ?? undefined
  const text = toHex(style.color) ?? undefined
  const theme: ITheme = {
    // The panel's own ground shows through (on macOS it is the window's
    // glass), so the terminal's matches it exactly by having none.
    background: '#00000000',
    foreground: text,
    cursor: text,
    cursorAccent: token('--background'),
    selectionBackground: token('--terminal-selection'),
  }
  for (const slot of ANSI) theme[slot] = token(tokenOf(slot))
  return theme
}

/** The app's monospace stack (`--font-mono`), for the terminal's cells. */
export function terminalFont(mount: HTMLElement): string {
  const family = getComputedStyle(mount).getPropertyValue('--font-mono').trim()
  return family || 'ui-monospace, SFMono-Regular, Menlo, monospace'
}
