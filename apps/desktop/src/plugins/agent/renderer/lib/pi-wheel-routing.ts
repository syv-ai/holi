const TRACKING_MODES = [9, 1000, 1002, 1003] as const
const ALTERNATE_MODES = [47, 1047, 1049] as const
const PIXELS_PER_NOTCH = 40
const DOM_DELTA_LINE = 1
const DOM_DELTA_PAGE = 2
const MAX_PENDING_CONTROL = 4096

type TerminalModes = { alternateScreen: boolean; mouseTracking: boolean; sgrMouse: boolean }

const disabledModes = (): TerminalModes => ({
  alternateScreen: false,
  mouseTracking: false,
  sgrMouse: false,
})

/** Observes split terminal output and only forwards wheel input to a live Pi TUI. */
export function createPiWheelRouter(write: (data: string) => void) {
  let modes = disabledModes()
  let state: 'ground' | 'escape' | 'csi' | 'string' | 'string-escape' = 'ground'
  let pending = ''
  let distance = 0

  const applyCsi = (sequence: string) => {
    if (sequence.at(-1) !== 'h' && sequence.at(-1) !== 'l') return
    const body = sequence.startsWith('\x1b[') ? sequence.slice(2, -1) : sequence.slice(1, -1)
    if (!/^\?[0-9;]*$/.test(body)) return
    const enabled = sequence.at(-1) === 'h'
    for (const raw of body.slice(1).split(';')) {
      const mode = Number(raw)
      if (TRACKING_MODES.includes(mode as (typeof TRACKING_MODES)[number]))
        modes.mouseTracking = enabled
      else if (mode === 1006) modes.sgrMouse = enabled
      else if (ALTERNATE_MODES.includes(mode as (typeof ALTERNATE_MODES)[number]))
        modes.alternateScreen = enabled
    }
  }

  const observeOutput = (data: string) => {
    for (const char of data) {
      const code = char.charCodeAt(0)
      switch (state) {
        case 'ground':
          if (char === '\x1b') {
            pending = char
            state = 'escape'
          }
          break
        case 'escape':
          if (char === '\x1b') {
            pending = char
          } else if (char === '[') {
            pending += char
            state = 'csi'
          } else if (char === ']' || char === 'P' || char === 'X' || char === '^' || char === '_') {
            pending = ''
            state = 'string'
          } else {
            // ESC c is RIS. Handle it in stream order; other escape sequences
            // cannot alter the modes used for routing.
            if (char === 'c') {
              modes = disabledModes()
              distance = 0
            }
            pending = ''
            state = 'ground'
          }
          break
        case 'csi':
          if (char === '\x1b') {
            pending = char
            state = 'escape'
          } else if (char === '\x18' || char === '\x1a') {
            pending = ''
            state = 'ground'
          } else if (code >= 0x40 && code <= 0x7e) {
            pending += char
            applyCsi(pending)
            pending = ''
            state = 'ground'
          } else {
            pending += char
            if (pending.length > MAX_PENDING_CONTROL) {
              pending = ''
              state = 'ground'
            }
          }
          break
        case 'string':
          if (char === '\x07' || char === '\x18' || char === '\x1a') {
            state = 'ground'
          } else if (char === '\x1b') {
            state = 'string-escape'
          }
          break
        case 'string-escape':
          if (char === '\\') state = 'ground'
          else state = char === '\x1b' ? 'string-escape' : 'string'
          break
      }
      if (state !== 'csi' && state !== 'escape') pending = ''
    }
  }

  const onWheel = (event: WheelEvent, bounds: DOMRect, cols: number, rows: number) => {
    if (
      cols < 1 ||
      rows < 1 ||
      bounds.width <= 0 ||
      bounds.height <= 0 ||
      !modes.alternateScreen ||
      !modes.mouseTracking ||
      !modes.sgrMouse ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey
    )
      return false

    const relativeX = event.clientX - bounds.left
    const relativeY = event.clientY - bounds.top
    if (relativeX < 0 || relativeY < 0 || relativeX >= bounds.width || relativeY >= bounds.height)
      return false

    event.preventDefault()
    event.stopPropagation()
    const cellWidth = bounds.width / cols
    const cellHeight = bounds.height / rows
    const units =
      event.deltaMode === DOM_DELTA_LINE
        ? event.deltaY * cellHeight
        : event.deltaMode === DOM_DELTA_PAGE
          ? event.deltaY * rows * cellHeight
          : event.deltaY
    distance += units
    const notches = Math.trunc(distance / PIXELS_PER_NOTCH)
    if (!notches) return true
    distance -= notches * PIXELS_PER_NOTCH

    const x = Math.floor(relativeX / cellWidth) + 1
    const y = Math.floor(relativeY / cellHeight) + 1
    const button = notches > 0 ? 65 : 64
    for (let i = 0; i < Math.min(Math.abs(notches), 100); i++) write(`\x1b[<${button};${x};${y}M`)
    return true
  }

  return { observeOutput, onWheel }
}
