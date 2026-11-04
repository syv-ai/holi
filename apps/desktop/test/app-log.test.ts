/**
 * The application log (docs/features/status-bar.md): everything Holi prints,
 * kept raw in a bounded ring for the bottom panel's Logs tab, scrubbed of
 * credentials as it is written.
 */
import { describe, expect, it, vi } from 'vitest'
import { captureConsole, createAppLog, rendererLevel } from '../src/main/logs/app-log'

const AT = '2026-10-24T10:00:00.000Z'

describe('app log', () => {
  it('splits a line into its scope, its first line and the rest', () => {
    const log = createAppLog({ now: () => AT })
    log.write({
      level: 'error',
      source: 'main',
      text: '[router] post-write rescan: Error: boom\n    at rescan (router.ts:1)',
    })
    log.write({ level: 'info', source: 'renderer', text: 'plain line' })
    expect(log.entries()).toEqual([
      {
        id: 1,
        at: AT,
        level: 'error',
        source: 'main',
        scope: 'router',
        message: 'post-write rescan: Error: boom',
        detail: '    at rescan (router.ts:1)',
      },
      { id: 2, at: AT, level: 'info', source: 'renderer', message: 'plain line' },
    ])
  })

  it('scrubs credentials and skips blank lines', () => {
    const log = createAppLog()
    log.write({
      level: 'warn',
      source: 'main',
      text: 'push https://x-access-token:ghs_abcdefghijklmnopqrstuvwx@github.com/o/r failed',
    })
    log.write({ level: 'info', source: 'main', text: '   \n  ' })
    const [only, ...rest] = log.entries()
    expect(rest).toEqual([])
    expect(only?.message).not.toContain('ghs_')
    expect(only?.message).toContain('***@github.com')
  })

  it('drops the oldest past its capacity, and ids keep counting', () => {
    const log = createAppLog({ capacity: 2 })
    for (let i = 1; i <= 4; i++) log.write({ level: 'info', source: 'main', text: `line ${i}` })
    expect(log.entries().map((e) => [e.id, e.message])).toEqual([
      [3, 'line 3'],
      [4, 'line 4'],
    ])
    log.clear()
    expect(log.entries()).toEqual([])
  })

  it('pushes each line as it is kept, and a failing push does not throw', () => {
    const pushed: string[] = []
    const log = createAppLog({ onEntry: (e) => pushed.push(e.message) })
    log.write({ level: 'info', source: 'main', text: 'one' })
    expect(pushed).toEqual(['one'])
    const broken = createAppLog({
      onEntry: () => {
        throw new Error('window gone')
      },
    })
    expect(() => broken.write({ level: 'info', source: 'main', text: 'two' })).not.toThrow()
  })

  it('reads the window console levels', () => {
    expect(rendererLevel('warning')).toBe('warn')
    expect(rendererLevel('error')).toBe('error')
    expect(rendererLevel('debug')).toBe('debug')
  })
})

describe('console capture', () => {
  function fakeConsole() {
    return { debug: vi.fn(), log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  }

  it('still prints, keeps a copy at the right level, and undoes', () => {
    const target = fakeConsole()
    const printed = target.error
    const log = createAppLog()
    const undo = captureConsole(log, target)
    target.error('[vaults] could not push %s:', 'o/r', new Error('offline'))
    target.log('started')
    expect(printed).toHaveBeenCalledOnce()
    expect(log.entries().map((e) => [e.level, e.scope, e.message])).toEqual([
      ['error', 'vaults', 'could not push o/r: Error: offline'],
      ['info', undefined, 'started'],
    ])
    undo()
    expect(target.error).toBe(printed)
  })

  it('does not log what the log itself prints while writing', () => {
    const target = fakeConsole()
    // A push that prints, as a failing send would: one line, not a loop.
    const log = createAppLog({ onEntry: () => target.warn('push failed') })
    captureConsole(log, target)
    target.info('hello')
    expect(log.entries().map((e) => e.message)).toEqual(['hello'])
  })
})
