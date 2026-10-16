import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: any[]) => void>>()
  const updater = {
    on: (event: string, listener: (...args: any[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return updater
    },
    removeAllListeners: () => listeners.clear(),
    emit: (event: string, ...args: any[]) => {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    listeners,
  } as Record<string, any>
  return { updater, read: vi.fn(), update: vi.fn() }
})

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/holi-test',
    isPackaged: true,
    getVersion: () => '1.0.0',
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
}))
vi.mock('electron-updater', () => ({ autoUpdater: mocks.updater }))
vi.mock('../src/main/json-file-store', () => ({
  jsonFileStore: () => ({ read: mocks.read, update: mocks.update }),
}))

import { createUpdater } from '../src/main/updates/updater'

const tick = () => new Promise((resolve) => setImmediate(resolve))

beforeEach(() => {
  mocks.updater.removeAllListeners()
  Object.assign(mocks.updater, {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  })
  mocks.read.mockResolvedValue({ enabled: true, channel: 'stable' })
  mocks.update.mockImplementation(async (change) => change({ enabled: true, channel: 'stable' }))
})

describe('updater channel switching', () => {
  it('keeps native install-on-quit disabled and only explicitly installs a ready candidate', async () => {
    const updater = createUpdater({ send: vi.fn(), beforeInstall: async () => true })
    await tick()
    expect(mocks.updater.channel).toBe('latest')
    expect(mocks.updater.autoInstallOnAppQuit).toBe(false)
    mocks.updater.emit('update-available', { version: '1.1.0' })
    mocks.updater.emit('update-downloaded')
    expect(mocks.updater.autoInstallOnAppQuit).toBe(false)
    expect(updater.status()).toMatchObject({ state: 'ready', availableVersion: '1.1.0' })
    expect(updater.installOnQuit()).toBe(true)
    expect(mocks.updater.quitAndInstall).toHaveBeenCalledOnce()
    updater.dispose()
  })

  it('waits for persisted preferences before checking and migrates unknown preferences to stable', async () => {
    let resolveRead!: (value: { enabled: boolean; channel: 'stable' }) => void
    mocks.read.mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve
      }),
    )
    const updater = createUpdater({ send: vi.fn(), beforeInstall: async () => true })
    const check = updater.check()
    await tick()
    expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled()
    resolveRead({ enabled: true, channel: 'stable' })
    mocks.updater.checkForUpdates.mockResolvedValue({
      downloadPromise: Promise.resolve(),
      cancellationToken: { cancel: vi.fn() },
    })
    await check
    expect(mocks.updater.channel).toBe('latest')
    expect(mocks.updater.checkForUpdates).toHaveBeenCalledOnce()
    expect(mocks.updater.allowDowngrade).toBe(true)
    updater.dispose()
  })

  it('cancels and drains the previous channel download before checking the selected channel', async () => {
    const updater = createUpdater({ send: vi.fn(), beforeInstall: async () => true })
    await tick()
    let finish!: () => void
    const downloadPromise = new Promise<void>((resolve) => {
      finish = resolve
    })
    const cancel = vi.fn()
    mocks.updater.checkForUpdates.mockResolvedValue({
      downloadPromise,
      cancellationToken: { cancel },
    })
    const priorCheck = updater.check()
    await tick()
    const switching = updater.setChannel('dev')
    await tick()
    expect(cancel).toHaveBeenCalledOnce()
    expect(mocks.updater.checkForUpdates).toHaveBeenCalledOnce()
    finish()
    await priorCheck
    mocks.updater.checkForUpdates.mockResolvedValue({
      downloadPromise: Promise.resolve(),
      cancellationToken: { cancel: vi.fn() },
    })
    await switching
    expect(mocks.updater.channel).toBe('dev')
    expect(mocks.updater.checkForUpdates).toHaveBeenCalledTimes(2)
    expect(updater.status().channel).toBe('dev')
    updater.dispose()
  })

  it('does not install a ready candidate staged on the previous channel', async () => {
    const updater = createUpdater({ send: vi.fn(), beforeInstall: async () => true })
    await tick()
    mocks.updater.emit('update-available', { version: '1.1.0' })
    mocks.updater.emit('update-downloaded')
    mocks.updater.checkForUpdates.mockResolvedValue({
      downloadPromise: Promise.resolve(),
      cancellationToken: { cancel: vi.fn() },
    })
    await updater.setChannel('dev')
    expect(updater.status()).toMatchObject({
      channel: 'dev',
      state: 'checking',
      availableVersion: null,
    })
    expect(updater.installOnQuit()).toBe(false)
    expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled()
    expect(mocks.updater.autoInstallOnAppQuit).toBe(false)
    updater.dispose()
  })

  it('restores channel switching after a failed preference write', async () => {
    const updater = createUpdater({ send: vi.fn(), beforeInstall: async () => true })
    await tick()
    mocks.update.mockRejectedValueOnce(new Error('disk full'))
    await expect(updater.setChannel('dev')).rejects.toThrow('disk full')
    expect(updater.status().channel).toBe('stable')
    mocks.updater.checkForUpdates.mockResolvedValue({
      downloadPromise: Promise.resolve(),
      cancellationToken: { cancel: vi.fn() },
    })
    await updater.check()
    expect(mocks.updater.checkForUpdates).toHaveBeenCalledOnce()
    updater.dispose()
  })

  it('drains an explicit download before changing channel', async () => {
    const updater = createUpdater({ send: vi.fn(), beforeInstall: async () => true })
    await tick()
    mocks.updater.emit('update-available', { version: '1.1.0' })
    let finish!: () => void
    mocks.updater.downloadUpdate.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      }),
    )
    const downloading = updater.download()
    await tick()
    const switching = updater.setChannel('dev')
    await tick()
    expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled()
    finish()
    await downloading
    mocks.updater.checkForUpdates.mockResolvedValue({
      downloadPromise: Promise.resolve(),
      cancellationToken: { cancel: vi.fn() },
    })
    await switching
    expect(updater.status().channel).toBe('dev')
    expect(updater.installOnQuit()).toBe(false)
    updater.dispose()
  })
})
