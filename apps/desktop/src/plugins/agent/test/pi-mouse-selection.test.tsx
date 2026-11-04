import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it } from 'vitest'
import { createPiMouseSelectionFilter } from '../renderer/lib/pi-mouse-selection'

const terminals: Terminal[] = []

afterEach(() => {
  for (const term of terminals.splice(0)) term.dispose()
})

function terminal() {
  const term = new Terminal()
  terminals.push(term)
  return term
}

async function write(term: Terminal, data: string, filter?: (data: string) => string) {
  const output = filter ? filter(data) : data
  if (output) await new Promise<void>((resolve) => term.write(output, resolve))
}

describe('Pi terminal mouse selection', () => {
  it.each([9, 1000, 1002, 1003])(
    'suppresses tracking mode %i, including repeated enables',
    async (mode) => {
      const term = terminal()
      const filter = createPiMouseSelectionFilter()

      await write(term, `\x1b[?${mode}h`, filter)
      expect(term.modes.mouseTrackingMode).toBe('none')
      await write(term, `\x1b[?${mode}h`, filter)
      expect(term.modes.mouseTrackingMode).toBe('none')
    },
  )

  it('preserves other modes in a mixed DECSET sequence', async () => {
    const term = terminal()
    const filter = createPiMouseSelectionFilter()

    await write(term, '\x1b[?1003;1006;2004;1h', filter)
    expect(term.modes.mouseTrackingMode).toBe('none')
    expect(term.modes.bracketedPasteMode).toBe(true)
    expect(term.modes.applicationCursorKeysMode).toBe(true)
  })

  it('preserves SGR when a later PTY chunk completes an unfinished CSI', async () => {
    const term = terminal()
    const filter = createPiMouseSelectionFilter()

    await write(term, '\x1b[?1003h\x1b[', filter)
    await write(term, '31mred', filter)
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('red')
    expect(term.buffer.active.getLine(0)?.getCell(0)?.getFgColor()).toBe(1)
  })

  it('filters split tracking sequences at every boundary and preserves ordering', async () => {
    const sequence = '\x1b[?1003;1006h'
    for (let split = 1; split < sequence.length; split++) {
      const term = terminal()
      const filter = createPiMouseSelectionFilter()
      await write(term, 'before', filter)
      await write(term, sequence.slice(0, split), filter)
      await write(term, sequence.slice(split) + 'after', filter)
      expect(term.modes.mouseTrackingMode).toBe('none')
      expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('beforeafter')
      term.dispose()
      terminals.splice(terminals.indexOf(term), 1)
    }
  })

  it('preserves mixed allowed tracking parameters while suppressing blocked modes', async () => {
    const term = terminal()
    const filter = createPiMouseSelectionFilter()

    await write(term, '\x1b[?9;1000;1002;1003;1006;2004h', filter)
    expect(term.modes.mouseTrackingMode).toBe('none')
    expect(term.modes.bracketedPasteMode).toBe(true)
  })

  it('preserves unknown DECSET parameters and unrelated control bytes', async () => {
    const filter = createPiMouseSelectionFilter()
    const sequence = '\\x1b[?777;1006;2004h'
    expect(filter(sequence)).toBe(sequence)
  })

  it('leaves unrelated ANSI, Unicode, and control-string bytes unchanged', async () => {
    const term = terminal()
    const filter = createPiMouseSelectionFilter()
    const output = '\x1b]0;title \x1b[?1003h\x07\x1bPpayload\x1b[?1003h\x1b\\λ\x1b[31mred\x1b[0m'

    expect(filter(output)).toBe(output)
    await write(term, output, filter)
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('λred')
  })

  it('supports 8-bit CSI and leading-zero DECSET parameters', async () => {
    const term = terminal()
    const filter = createPiMouseSelectionFilter()

    await write(term, '\x9b?01003h', filter)
    expect(term.modes.mouseTrackingMode).toBe('none')
  })

  it('does not change native tracking when no Pi policy is installed', async () => {
    const term = terminal()
    await write(term, '\x1b[?1003h')
    expect(term.modes.mouseTrackingMode).toBe('any')
  })
})
