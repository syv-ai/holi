import { describe, expect, it } from 'vitest'
import { preservePiMouseSelection } from '../renderer/lib/pi-mouse-selection'

function createTerminal() {
  const listeners = new Set<() => void>()
  const writes: string[] = []
  const term = {
    modes: { mouseTrackingMode: 'none' as 'none' | 'x10' | 'vt200' | 'drag' | 'any' },
    onWriteParsed(listener: () => void) {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    write(data: string) {
      writes.push(data)
      if (data === '\x1b[?9;1000;1002;1003l') term.modes.mouseTrackingMode = 'none'
    },
    parse(mode: 'none' | 'x10' | 'vt200' | 'drag' | 'any') {
      term.modes.mouseTrackingMode = mode
      for (const listener of listeners) listener()
    },
    writes,
  }
  return term
}

describe('Pi terminal mouse selection', () => {
  it.each(['x10', 'vt200', 'drag', 'any'] as const)(
    'resets %s tracking after parsed output',
    (mode) => {
      const terminal = createTerminal()
      const subscription = preservePiMouseSelection(terminal)

      terminal.parse(mode)
      expect(terminal.writes).toEqual(['\x1b[?9;1000;1002;1003l'])
      expect(terminal.modes.mouseTrackingMode).toBe('none')

      subscription.dispose()
      terminal.parse(mode)
      expect(terminal.writes).toHaveLength(1)
    },
  )

  it('only writes while tracking is enabled, so reset callbacks do not loop', () => {
    const terminal = createTerminal()
    preservePiMouseSelection(terminal)

    terminal.parse('none')
    expect(terminal.writes).toEqual([])
    terminal.parse('any')
    terminal.parse('none')
    expect(terminal.writes).toHaveLength(1)
  })
})
