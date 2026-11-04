import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { preservePiMouseSelection } from '../renderer/lib/pi-mouse-selection'

const terminals: Terminal[] = []

afterEach(() => {
  for (const term of terminals.splice(0)) term.dispose()
})

function terminal() {
  const term = new Terminal()
  terminals.push(term)
  return term
}

async function write(term: Terminal, data: string) {
  await new Promise<void>((resolve) => term.write(data, resolve))
  // The policy queues its reset after parsing. A second write drains that reset
  // before asserting on the real parser's modes, without a timing-based wait.
  await new Promise<void>((resolve) => term.write('\x1b[0m', resolve))
}

describe('Pi terminal mouse selection', () => {
  it.each([
    ['X10', 9],
    ['VT200', 1000],
    ['drag', 1002],
    ['any-motion', 1003],
  ] as const)('resets %s tracking after parsed output', async (_name, mode) => {
    const term = terminal()
    preservePiMouseSelection(term)

    await write(term, `\x1b[?${mode}h`)
    expect(term.modes.mouseTrackingMode).toBe('none')
  })

  it('preserves paste and cursor modes in a combined DECSET sequence', async () => {
    const term = terminal()
    preservePiMouseSelection(term)

    await write(term, '\x1b[?1003;1006;2004;1h')
    expect(term.modes.mouseTrackingMode).toBe('none')
    expect(term.modes.bracketedPasteMode).toBe(true)
    expect(term.modes.applicationCursorKeysMode).toBe(true)
  })

  it('resets tracking again after later output enables it', async () => {
    const term = terminal()
    preservePiMouseSelection(term)

    await write(term, '\x1b[?1003hfirst output')
    expect(term.modes.mouseTrackingMode).toBe('none')
    await write(term, '\x1b[?1002hsecond output')
    expect(term.modes.mouseTrackingMode).toBe('none')
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('first outputsecond output')
  })

  it('does not queue resets for ordinary output or for its own reset', async () => {
    const term = terminal()
    const writes = vi.spyOn(term, 'write')
    preservePiMouseSelection(term)

    await write(term, 'ordinary output')
    expect(writes.mock.calls).toHaveLength(2)
    await write(term, '\x1b[?1003h')
    expect(writes.mock.calls.filter(([data]) => data === '\x1b[?9;1000;1002;1003l')).toHaveLength(1)
  })

  it('leaves native tracking alone when no Pi policy is installed', async () => {
    const term = terminal()

    await write(term, '\x1b[?1003h')
    expect(term.modes.mouseTrackingMode).toBe('any')
  })

  it('stops overriding tracking after disposal', async () => {
    const term = terminal()
    const subscription = preservePiMouseSelection(term)

    await write(term, '\x1b[?1003h')
    expect(term.modes.mouseTrackingMode).toBe('none')
    subscription.dispose()
    await write(term, '\x1b[?1003h')
    expect(term.modes.mouseTrackingMode).toBe('any')
  })
})
