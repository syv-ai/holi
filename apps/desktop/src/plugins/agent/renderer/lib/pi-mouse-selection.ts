/**
 * Pi enables xterm mouse reporting, which captures ordinary left drags. Filter
 * those DECSET parameters before xterm parses each PTY chunk, preserving all
 * other bytes and the terminal's parser state.
 */
const MOUSE_TRACKING_MODES = new Set(['9', '1000', '1002', '1003'])
const MAX_PENDING_CSI = 4096
const CSI_CONTROLS = /[\x00-\x17\x19\x1c-\x1f\x7f]/g

export function createPiMouseSelectionFilter(): (data: string) => string {
  let state: 'ground' | 'escape' | 'csi' = 'ground'
  let pending = ''

  function finishCsi(sequence: string): string {
    const prefix = sequence.startsWith('\x1b') ? sequence.indexOf('[') + 1 : 1
    const body = sequence.slice(prefix, -1)
    if (sequence.at(-1) !== 'h' || !/^\?[0-9;]*$/.test(body.replace(CSI_CONTROLS, '')))
      return sequence

    return (
      sequence.slice(0, prefix) +
      body.replace(/[0-9][0-9\x00-\x17\x19\x1c-\x1f\x7f]*/g, (param) =>
        MOUSE_TRACKING_MODES.has(String(Number(param.replace(CSI_CONTROLS, ''))))
          ? param.replace(/[0-9]/g, '0')
          : param,
      ) +
      'h'
    )
  }

  return (data) => {
    let output = ''
    for (const char of data) {
      const code = char.codePointAt(0)!
      // ESC and CSI restart parsing even inside an unfinished control sequence
      // or control string. Forward the old prefix, then inspect the new one.
      if (char === '\x1b' || char === '\x9b') {
        output += pending
        pending = char
        state = char === '\x1b' ? 'escape' : 'csi'
        continue
      }
      switch (state) {
        case 'ground':
          output += char
          break
        case 'escape':
          pending += char
          if (char === '[') state = 'csi'
          else if (
            pending.length > MAX_PENDING_CSI ||
            !(code <= 0x17 || code === 0x19 || (code >= 0x1c && code <= 0x1f) || code === 0x7f)
          ) {
            output += pending
            pending = ''
            state = 'ground'
          }
          break
        case 'csi':
          pending += char
          if (code >= 0x40 && code <= 0x7e) {
            output += finishCsi(pending)
            pending = ''
            state = 'ground'
          } else if (
            char === '\x18' ||
            char === '\x1a' ||
            code > 0x9f ||
            pending.length > MAX_PENDING_CSI
          ) {
            // Cancellation, invalid Unicode, and overlong sequences pass through
            // unchanged; never retain an unbounded or cancelled PTY fragment.
            output += pending
            pending = ''
            state = 'ground'
          }
          break
      }
    }
    return output
  }
}
