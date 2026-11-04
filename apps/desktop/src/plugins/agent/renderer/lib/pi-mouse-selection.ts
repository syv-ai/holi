/**
 * Pi enables xterm mouse reporting, which captures ordinary left drags. Filter
 * those DECSET parameters before xterm parses each PTY chunk, preserving all
 * other bytes and the terminal's parser state.
 */
const MOUSE_TRACKING_MODES = new Set(['9', '1000', '1002', '1003'])
const MAX_PENDING_CSI = 4096

export function createPiMouseSelectionFilter(): (data: string) => string {
  let state: 'ground' | 'escape' | 'csi' | 'string' | 'string-escape' = 'ground'
  let csi = ''

  function finishCsi(sequence: string): string {
    const prefix = sequence.startsWith('\x1b[') ? 2 : 1
    const body = sequence.slice(prefix, -1)
    if (!body.startsWith('?') || sequence.at(-1) !== 'h') return sequence

    const params = body.slice(1).split(';')
    if (params.some((param) => param !== '' && !/^\d+$/.test(param))) return sequence
    return (
      sequence.slice(0, prefix) +
      '?' +
      params
        .map((param) => (MOUSE_TRACKING_MODES.has(String(Number(param))) ? '0' : param))
        .join(';') +
      'h'
    )
  }

  return (data) => {
    let output = ''
    for (const char of data) {
      const code = char.codePointAt(0)!
      switch (state) {
        case 'ground':
          if (char === '\x1b') {
            state = 'escape'
            csi = char
          } else if (char === '\x9b') {
            state = 'csi'
            csi = char
          } else if (
            char === '\x90' ||
            char === '\x9d' ||
            char === '\x98' ||
            char === '\x9e' ||
            char === '\x9f'
          ) {
            state = 'string'
            output += char
          } else {
            output += char
          }
          break
        case 'escape':
          csi += char
          if (char === '[') state = 'csi'
          else if (char === ']' || char === 'P' || char === '^' || char === '_') {
            state = 'string'
            output += csi
            csi = ''
          } else {
            output += csi
            csi = ''
            state = 'ground'
          }
          break
        case 'csi':
          csi += char
          if (code >= 0x40 && code <= 0x7e) {
            output += finishCsi(csi)
            csi = ''
            state = 'ground'
          } else if (csi.length > MAX_PENDING_CSI) {
            output += csi
            csi = ''
            state = 'ground'
          }
          break
        case 'string':
          output += char
          if (char === '\x1b') state = 'string-escape'
          else if (char === '\x07' || char === '\x9c') state = 'ground'
          break
        case 'string-escape':
          output += char
          state = char === '\\' ? 'ground' : 'string'
          break
      }
    }
    return output
  }
}
