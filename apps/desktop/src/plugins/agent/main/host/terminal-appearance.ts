const ANSI_KEYS = [
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

export type TerminalAppearance = Record<string, string>

function rgb(value: unknown): string | null {
  if (typeof value !== 'string' || !/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(value)) return null
  return value.slice(0, 7).toLowerCase()
}

function bytes(value: string): string {
  return `${value.slice(1, 3)}/${value.slice(3, 5)}/${value.slice(5, 7)}`
}

function indexedColor(appearance: TerminalAppearance, index: number): string | null {
  if (index >= 0 && index < ANSI_KEYS.length) return rgb(appearance[ANSI_KEYS[index]!])
  if (index < 16 || index > 255) return null
  if (index < 232) {
    const level = [0, 95, 135, 175, 215, 255][(index - 16) % 6]!
    const n = Math.floor((index - 16) / 36)
    const values = [0, 95, 135, 175, 215, 255]
    return `#${values[n]!.toString(16).padStart(2, '0')}${values[Math.floor(((index - 16) % 36) / 6)]!.toString(16).padStart(2, '0')}${level.toString(16).padStart(2, '0')}`
  }
  const gray = 8 + (index - 232) * 10
  return `#${gray.toString(16).padStart(2, '0').repeat(3)}`
}

/** PTY-side appearance handling: terminal replies bypass user-input hooks. */
export class TerminalAppearanceProtocol {
  private pending = ''
  private subscribed = false
  private appearance: TerminalAppearance = {}
  private mode: 'dark' | 'light' = 'dark'

  feed(data: string): string[] {
    this.pending += data
    const replies: string[] = []
    let cursor = 0
    while (true) {
      const start = this.pending.indexOf('\x1b', cursor)
      if (start < 0) {
        cursor = this.pending.length
        break
      }
      if (start + 1 >= this.pending.length) {
        cursor = start
        break
      }
      const kind = this.pending[start + 1]
      if (kind === '[') {
        let end = start + 2
        while (end < this.pending.length && !/[\x40-\x7e]/.test(this.pending[end]!)) end++
        if (end === this.pending.length) {
          cursor = start
          break
        }
        const body = this.pending.slice(start + 2, end + 1)
        if (body === '?2031h') this.subscribed = true
        if (body === '?2031l') this.subscribed = false
        if (body === 'c' || body === '0c') replies.push('\x1b[?1;2c')
        cursor = end + 1
      } else if (kind === ']') {
        const bell = this.pending.indexOf('\x07', start + 2)
        const st = this.pending.indexOf('\x1b\\', start + 2)
        const end = bell < 0 ? st : st < 0 ? bell : Math.min(bell, st)
        if (end < 0) {
          cursor = start
          break
        }
        const body = this.pending.slice(start + 2, end)
        const terminator = this.pending[end] === '\x07' ? '\x07' : '\x1b\\'
        const fields = body.split(';')
        if ((fields[0] === '10' || fields[0] === '11') && fields[1] === '?') {
          const color = rgb(this.appearance[fields[0] === '10' ? 'foreground' : 'background'])
          if (color) replies.push(`\x1b]${fields[0]};rgb:${bytes(color)}${terminator}`)
        } else if (fields[0] === '4') {
          for (let i = 1; i + 1 < fields.length; i += 2) {
            if (fields[i + 1] !== '?') continue
            const index = Number(fields[i])
            const color = Number.isInteger(index) ? indexedColor(this.appearance, index) : null
            if (color) replies.push(`\x1b]4;${index};rgb:${bytes(color)}${terminator}`)
          }
        }
        cursor = end + terminator.length
      } else if ('PX^_'.includes(kind!)) {
        // DCS/SOS/PM/APC bodies are strings, not nested terminal commands.
        const end = this.pending.indexOf('\x1b\\', start + 2)
        if (end < 0) {
          cursor = start
          break
        }
        cursor = end + 2
      } else {
        cursor = start + 2
      }
    }
    this.pending = this.pending.slice(cursor)
    if (this.pending.length > 8192) {
      // Keep the string introducer until its terminator rather than parsing
      // an escape-looking suffix of an oversized control string as a command.
      const kind = this.pending[1]
      this.pending = kind && ']PX^_'.includes(kind) ? `\x1b${kind}${this.pending.slice(-1)}` : ''
    }
    return replies
  }

  update(value: unknown): boolean {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const next: TerminalAppearance = {}
    for (const key of ['foreground', 'background', ...ANSI_KEYS]) {
      const color = rgb((value as Record<string, unknown>)[key])
      if (color) next[key] = color
    }
    if (!next.foreground || !next.background) return false
    const changed = JSON.stringify(next) !== JSON.stringify(this.appearance)
    const background = (value as Record<string, unknown>).background
    const channels =
      typeof background === 'string'
        ? background.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})/i)
        : null
    const mode =
      channels &&
      channels.slice(1).reduce((sum, channel) => sum + Number.parseInt(channel!, 16), 0) > 3 * 127
        ? 'light'
        : 'dark'
    const modeChanged = mode !== this.mode
    this.mode = mode
    this.appearance = next
    return (changed || modeChanged) && this.subscribed
  }

  notification(): string {
    return this.mode === 'light' ? '\x1b[?997;2n' : '\x1b[?997;1n'
  }
}
