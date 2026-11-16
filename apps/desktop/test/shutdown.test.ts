import { expect, it } from 'vitest'
import { drainShutdown } from '../src/main/shutdown'

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
