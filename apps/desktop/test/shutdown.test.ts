import { expect, it, vi } from 'vitest'
import { drainShutdown, settleVaultForQuit } from '../src/main/shutdown'

function steps(log: string[], failAt?: string) {
  const run = (name: string) => async () => {
    log.push(name)
    if (name === failAt) throw new Error(`${name} failed`)
  }
  return {
    stopBackground: run('background'),
    stopPlugins: run('plugins'),
    closeTerminals: run('terminals'),
    disposeUpdater: () => log.push('updater'),
    settleVault: run('settle'),
    closeVaults: run('vaults'),
    closeBridge: run('bridge'),
  }
}

it('drains before disposing the updater and closing vault and bridge resources', async () => {
  const log: string[] = []
  await drainShutdown(steps(log))
  expect(log).toEqual([
    'background',
    'plugins',
    'terminals',
    'updater',
    'settle',
    'vaults',
    'bridge',
  ])
})

it('keeps later shutdown resources available when any drain fails', async () => {
  const log: string[] = []
  await expect(drainShutdown(steps(log, 'plugins'))).rejects.toThrow('plugins failed')
  expect(log).toEqual(['background', 'plugins'])
})

it('does not dispose the updater or close the vault after terminal cleanup fails', async () => {
  const log: string[] = []
  await expect(drainShutdown(steps(log, 'terminals'))).rejects.toThrow('terminals failed')
  expect(log).toEqual(['background', 'plugins', 'terminals'])
})

it.each(['commit', 'push'] as const)(
  'continues shutdown after a best-effort %s failure and clears its timer',
  async (failure) => {
    vi.useFakeTimers()
    const log: string[] = []
    const error = new Error('offline')
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await drainShutdown({
        ...steps(log),
        settleVault: () =>
          settleVaultForQuit({
            commitNow: async () => {
              log.push('commit')
              if (failure === 'commit') throw error
            },
            pushNow: async () => {
              log.push('push')
              if (failure === 'push') throw error
            },
          }),
      })
      expect(log).toEqual([
        'background',
        'plugins',
        'terminals',
        'updater',
        'commit',
        'push',
        'vaults',
        'bridge',
      ])
      expect(report).toHaveBeenCalledWith(`[quit] ${failure} failed:`, error)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      report.mockRestore()
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  },
)

it('bounds an unreachable remote and observes a push rejection after the quit budget expires', async () => {
  vi.useFakeTimers()
  const report = vi.spyOn(console, 'error').mockImplementation(() => {})
  let reject!: (error: Error) => void
  const pending = new Promise<void>((_resolve, fail) => {
    reject = fail
  })
  const log: string[] = []
  try {
    let closed = false
    const quitting = drainShutdown({
      ...steps(log),
      settleVault: () =>
        settleVaultForQuit({
          commitNow: async () => {
            log.push('commit')
          },
          pushNow: () => pending,
        }),
      closeVaults: async () => {
        closed = true
        log.push('vaults')
      },
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await quitting
    expect(closed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    const error = new Error('late network rejection')
    reject(error)
    await vi.advanceTimersByTimeAsync(0)
    expect(report).toHaveBeenCalledWith('[quit] push failed:', error)
    expect(log.at(-1)).toBe('bridge')
  } finally {
    report.mockRestore()
    vi.clearAllTimers()
    vi.useRealTimers()
  }
})
