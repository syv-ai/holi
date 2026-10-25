import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createNotificationScanner,
  createTurnSignals,
  isNotification,
  submits,
} from '../main/host/pty-signals'

afterEach(() => {
  vi.useRealTimers()
})

function rig(idleMs = 100) {
  vi.useFakeTimers()
  const edges: string[] = []
  const signals = createTurnSignals({
    idleMs,
    onBegin: () => edges.push('begin'),
    onEnd: () => edges.push('end'),
    onAttention: () => edges.push('attention'),
  })
  return { signals, edges }
}

describe('submits', () => {
  it('is an Enter typed outside a paste', () => {
    expect(submits('\r')).toBe(true)
    expect(submits('fix the build\r')).toBe(true)
    expect(submits('abc')).toBe(false)
    expect(submits('\x1b[200~line one\rline two\x1b[201~')).toBe(false)
    expect(submits('\x1b[200~pasted\x1b[201~\r')).toBe(true)
  })
})

describe('notifications', () => {
  it('reads OSC 9 and OSC 777 notify, not OSC 9;4 progress', () => {
    expect(isNotification('9;Codex wants to run a command')).toBe(true)
    expect(isNotification('777;notify;Codex;done')).toBe(true)
    expect(isNotification('9;4;1;50')).toBe(false)
    expect(isNotification('0;a title')).toBe(false)
  })

  it('finds a bell, and a notification split across chunks, but not a title', () => {
    const seen: number[] = []
    const scan = createNotificationScanner(() => seen.push(1))
    scan('\x1b]0;my session\x07') // a title ends in BEL too
    expect(seen).toHaveLength(0)
    scan('\x1b]9;needs')
    scan(' you\x1b')
    scan('\\')
    expect(seen).toHaveLength(1)
    scan('ding\x07')
    expect(seen).toHaveLength(2)
  })
})

describe('turn signals', () => {
  it('begins on Enter and ends after the quiet', () => {
    const { signals, edges } = rig()
    signals.input('hello')
    expect(edges).toEqual([])
    signals.input('\r')
    expect(edges).toEqual(['begin'])
    expect(signals.inTurn).toBe(true)

    // Output keeps it running.
    vi.advanceTimersByTime(80)
    signals.output('⠋ Working')
    vi.advanceTimersByTime(80)
    expect(edges).toEqual(['begin'])

    vi.advanceTimersByTime(30)
    expect(edges).toEqual(['begin', 'end'])
    expect(signals.inTurn).toBe(false)
  })

  it('takes one begin per turn, and a hook end ends it at once', () => {
    const { signals, edges } = rig()
    signals.input('\r')
    signals.input('\r')
    signals.end()
    signals.end()
    expect(edges).toEqual(['begin', 'end'])
  })

  it('says when a notification arrives', () => {
    const { signals, edges } = rig()
    signals.begin()
    signals.output('\x1b]9;approve?\x07')
    expect(edges).toEqual(['begin', 'attention'])
  })

  it('goes quiet once disposed', () => {
    const { signals, edges } = rig()
    signals.begin()
    signals.dispose()
    vi.advanceTimersByTime(500)
    signals.input('\r')
    expect(edges).toEqual(['begin'])
  })
})
