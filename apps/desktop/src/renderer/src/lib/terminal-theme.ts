/**
 * The bottom panel's xterm theme, read from the app's CSS tokens
 * (`--terminal-*`, `--foreground`, `--background` in `index.css`), so a
 * terminal follows light and dark and a vault's theme like the rest of the
 * window. Read again when the mode swaps.
 */
import type { ITheme, Terminal } from '@xterm/xterm'

/** Main owns color replies and the trailing DA1 query that completes the native batch. */
export function suppressTerminalColorQueries(term: Pick<Terminal, 'parser'>): () => void {
  const handlers = [
    term.parser.registerOscHandler(10, (data) => data === '?'),
    term.parser.registerOscHandler(11, (data) => data === '?'),
    term.parser.registerOscHandler(4, (data) => /^(?:\d+;\?)(?:;\d+;\?)*$/.test(data)),
    term.parser.registerCsiHandler(
      { final: 'c' },
      (params) => params.length === 0 || (params.length === 1 && params[0] === 0),
    ),
  ]
  return () => handlers.forEach((handler) => handler.dispose())
}

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
function toHex(color: string, alpha = true): string | null {
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
  // An opaque sample preserves the logical surface RGB for terminal queries;
  // transparent canvas pixels otherwise discard RGB on readback.
  return alpha ? `#${hex(r)}${hex(g)}${hex(b)}${hex(a)}` : `#${hex(r)}${hex(g)}${hex(b)}`
}

/** The theme for an xterm mounted in `mount`. */
export function terminalTheme(mount: HTMLElement): ITheme {
  const style = getComputedStyle(mount)
  const token = (name: string) => toHex(style.getPropertyValue(name)) ?? undefined
  const rootStyle = getComputedStyle(document.documentElement)
  const surface =
    toHex(rootStyle.getPropertyValue('--background'), false) ??
    toHex(rootStyle.backgroundColor, false) ??
    '#000000'
  const text = toHex(style.color) ?? undefined
  const theme: ITheme = {
    // Keep the surface's logical RGB for OSC 11 while painting with zero alpha,
    // so xterm does not cover the pane's native (including macOS glass) surface.
    background: `${surface}00`,
    foreground: text,
    cursor: text,
    cursorAccent: token('--background'),
    selectionBackground: token('--terminal-selection'),
  }
  for (const slot of ANSI) theme[slot] = token(tokenOf(slot))
  return theme
}

/**
 * Keep a live xterm in step with the document's resolved light/dark and vault
 * CSS tokens. Root `style` changes include same-mode vault theme edits.
 */
export function watchTerminalTheme(
  mount: HTMLElement,
  update: (theme: ITheme) => void,
): () => void {
  const root = document.documentElement
  let frame = 0
  const observer = new MutationObserver(() => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => update(terminalTheme(mount)))
  })
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'style'] })
  return () => {
    observer.disconnect()
    cancelAnimationFrame(frame)
  }
}

/** The app's monospace stack (`--font-mono`), for the terminal's cells. */
export function terminalFont(mount: HTMLElement): string {
  const family = getComputedStyle(mount).getPropertyValue('--font-mono').trim()
  return family || 'ui-monospace, SFMono-Regular, Menlo, monospace'
}
