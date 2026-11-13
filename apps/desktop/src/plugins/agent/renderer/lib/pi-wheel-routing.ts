const TRACKING_MODES = [9, 1000, 1002, 1003] as const
const ALTERNATE_MODES = [47, 1047, 1049] as const
const PIXELS_PER_NOTCH = 40
const CELL_HEIGHT = 16
const CSI = /\x1b\[\?([0-9;]*)([hl])/g

/** Observes split terminal output and only forwards wheel input to a live Pi TUI. */
export function createPiWheelRouter(write: (data: string) => void) {
  let modes = { alternateScreen: false, mouseTracking: false, sgrMouse: false }
  let pending = ''
  let distance = 0

  const observeOutput = (data: string) => {
    const input = pending + data
    // Preserve only a bounded, incomplete private-mode CSI across writes.
    const lastEscape = input.lastIndexOf('\x1b[')
    const suffix = lastEscape < 0 ? '' : input.slice(lastEscape)
    pending = suffix.length <= 4096 && /^\x1b\[\?[0-9;]*$/.test(suffix) ? suffix : ''
    const complete = pending ? input.slice(0, -pending.length) : input
    for (const match of complete.matchAll(CSI)) {
      const enabled = match[2] === 'h'
      for (const raw of match[1]!.split(';')) {
        const mode = Number(raw)
        if (TRACKING_MODES.includes(mode as (typeof TRACKING_MODES)[number]))
          modes.mouseTracking = enabled
        else if (mode === 1006) modes.sgrMouse = enabled
        else if (ALTERNATE_MODES.includes(mode as (typeof ALTERNATE_MODES)[number]))
          modes.alternateScreen = enabled
      }
    }
    // RIS resets terminal state. It also prevents an old session mode from
    // authorizing wheel writes after a terminal clear/restart in the stream.
    if (complete.includes('\x1bc')) {
      modes = { alternateScreen: false, mouseTracking: false, sgrMouse: false }
      distance = 0
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

    event.preventDefault()
    event.stopPropagation()
    const units =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY * CELL_HEIGHT
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * rows * CELL_HEIGHT
          : event.deltaY
    distance += units
    const notches = Math.trunc(distance / PIXELS_PER_NOTCH)
    if (!notches) return true
    distance -= notches * PIXELS_PER_NOTCH

    const x = Math.max(
      1,
      Math.min(cols, Math.floor(((event.clientX - bounds.left) / bounds.width) * cols) + 1),
    )
    const y = Math.max(
      1,
      Math.min(rows, Math.floor(((event.clientY - bounds.top) / bounds.height) * rows) + 1),
    )
    const button = notches > 0 ? 65 : 64
    for (let i = 0; i < Math.abs(notches); i++) write(`\x1b[<${button};${x};${y}M`)
    return true
  }

  return { observeOutput, onWheel }
}
