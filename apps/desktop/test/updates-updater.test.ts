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
  return {
    updater,
    read: vi.fn(),
    update: vi.fn(),
    readPackage: vi.fn(),
    adapter: null as any,
    appOnce: vi.fn(),
    appQuit: vi.fn(),
    appRelaunch: vi.fn(),
  }
})

vi.mock('node:fs', () => ({ readFileSync: mocks.readPackage }))
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => `/tmp/holi-test/${name}`,
    getAppPath: () => '/tmp/holi-app',
    getName: () => 'Holi',
    whenReady: () => Promise.resolve(),
    relaunch: mocks.appRelaunch,
    quit: mocks.appQuit,
    once: mocks.appOnce,
    isPackaged: true,
    getVersion: () => '0.1.2',
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
}))
vi.mock('electron-updater', () => ({
  MacUpdater: class {
    constructor(_options: unknown, adapter: unknown) {
      mocks.adapter = adapter
      return mocks.updater as any
    }
  },
}))
vi.mock('../src/main/json-file-store', () => ({
  jsonFileStore: () => ({ read: mocks.read, update: mocks.update }),
}))

import { createUpdater } from '../src/main/updates/updater'

const tick = () => new Promise((resolve) => setImmediate(resolve))

beforeEach(() => {
  Object.defineProperty(process, 'resourcesPath', { value: '/resources', configurable: true })
  mocks.updater.removeAllListeners()
  Object.assign(mocks.updater, {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  })
  mocks.read.mockResolvedValue({ enabled: true, channel: 'stable' })
  mocks.readPackage.mockReturnValue(JSON.stringify({ version: '0.1.2-dev.42' }))
  mocks.adapter = null
  mocks.update.mockImplementation(async (change) => change({ enabled: true, channel: 'stable' }))
})

describe('updater channel switching', () => {
  it('uses the packed package version while forwarding Electron app paths and lifecycle', async () => {
    const updater = createUpdater({ send: vi.fn(), beforeInstall: async () => true })
    expect(updater.status().version).toBe('0.1.2-dev.42')
    const adapter = mocks.adapter as {
      version: string
      name: string
      isPackaged: boolean
      appUpdateConfigPath: string
      userDataPath: string
      baseCachePath: string
      whenReady(): Promise<void>
      relaunch(): void
      quit(): void
      onQuit(handler: (exitCode: number) => void): void
    }
    expect(adapter.version).toBe('0.1.2-dev.42')
    expect(adapter.name).toBe('Holi')
    expect(adapter.isPackaged).toBe(true)
    expect(adapter.appUpdateConfigPath).toBe('/resources/app-update.yml')
    expect(adapter.userDataPath).toBe('/tmp/holi-test/userData')
    expect(adapter.baseCachePath).toBeTypeOf('string')
    await expect(adapter.whenReady()).resolves.toBeUndefined()
    adapter.relaunch()
    adapter.quit()
    expect(mocks.appRelaunch).toHaveBeenCalledOnce()
    expect(mocks.appQuit).toHaveBeenCalledOnce()
    const onExit = vi.fn()
    adapter.onQuit(onExit)
    expect(mocks.appOnce).toHaveBeenCalledWith('quit', expect.any(Function))
    mocks.appOnce.mock.calls[0][1]({}, 3)
    expect(onExit).toHaveBeenCalledWith(3)
  })

  it('applies rapid channel selections in order', async () => {
    const updater = createUpdater({ send: vi.fn(), beforeInstall: async () => true })
    await tick()
    let persistFirst!: () => void
    const firstPersist = new Promise<void>((resolve) => {
      persistFirst = resolve
    })
    mocks.update.mockImplementationOnce(async (change) => {
      await firstPersist
      return change({ enabled: true, channel: 'stable' })
    })
    mocks.updater.checkForUpdates.mockResolvedValue({
      downloadPromise: Promise.resolve(),
      cancellationToken: { cancel: vi.fn() },
    })
    const toDev = updater.setChannel('dev')
    const toStable = updater.setChannel('stable')
    await tick()
    persistFirst()
    await Promise.all([toDev, toStable])
    expect(updater.status().channel).toBe('stable')
    expect(mocks.updater.channel).toBe('latest')
    updater.dispose()
  })
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
