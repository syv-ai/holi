import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: any[]) => void>>()
  const updater = {
    on: (event: string, listener: (...args: any[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return updater
    },
    removeListener: (event: string, listener: (...args: any[]) => void) => {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((l) => l !== listener),
      )
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
    macUpdater: vi.fn(),
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => `/tmp/holi-test/${name}`,
    isPackaged: true,
    getVersion: () => '0.1.2-dev.42',
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
}))
vi.mock('electron-updater', () => ({
  autoUpdater: mocks.updater,
  MacUpdater: mocks.macUpdater,
}))
vi.mock('../src/main/json-file-store', () => ({
  jsonFileStore: () => ({ read: mocks.read, update: mocks.update }),
}))

import { createUpdater } from '../src/main/updates/updater'

const tick = () => new Promise((resolve) => setImmediate(resolve))

beforeEach(() => {
  mocks.updater.removeAllListeners()
  Object.assign(mocks.updater, {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowDowngrade: false,
    _channel: null,
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  })
  // electron-updater's channel setter enables downgrades automatically.
  Object.defineProperty(mocks.updater, 'channel', {
    configurable: true,
    get() {
      return this._channel
    },
    set(channel) {
      this._channel = channel
      this.allowDowngrade = true
    },
  })
  mocks.read.mockResolvedValue({ enabled: true, channel: 'stable' })
  mocks.update.mockImplementation(async (change) => change({ enabled: true, channel: 'stable' }))
})

describe('updater channel switching', () => {
  it('uses Electron app.getVersion with the default updater adapter', () => {
    const updater = createUpdater({
      send: vi.fn(),
      beforeInstall: async () => true,
      installFailed: vi.fn(),
    })
    expect(updater.status().version).toBe('0.1.2-dev.42')
    expect(mocks.macUpdater).not.toHaveBeenCalled()
  })

  it('applies rapid channel selections in order', async () => {
    const updater = createUpdater({
      send: vi.fn(),
      beforeInstall: async () => true,
      installFailed: vi.fn(),
    })
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
    const updater = createUpdater({
      send: vi.fn(),
      beforeInstall: async () => true,
      installFailed: vi.fn(),
    })
    await tick()
    expect(mocks.updater.channel).toBe('latest')
    expect(mocks.updater.autoDownload).toBe(true)
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
    const updater = createUpdater({
      send: vi.fn(),
      beforeInstall: async () => true,
      installFailed: vi.fn(),
    })
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
    const updater = createUpdater({
      send: vi.fn(),
      beforeInstall: async () => true,
      installFailed: vi.fn(),
    })
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

  it('keeps the ready update when the guarded restart is cancelled', async () => {
    const beforeInstall = vi.fn(async () => false)
    const updater = createUpdater({ send: vi.fn(), beforeInstall, installFailed: vi.fn() })
    await tick()
    mocks.updater.emit('update-available', { version: '1.1.0' })
    mocks.updater.emit('update-downloaded')

    await expect(updater.install()).resolves.toBe(false)

    expect(beforeInstall).toHaveBeenCalledOnce()
    expect(updater.status()).toMatchObject({ state: 'ready', availableVersion: '1.1.0' })
    expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled()
    updater.dispose()
  })

  it('waits for the guarded install outcome before reporting success', async () => {
    let allowInstall!: (go: boolean) => void
    const beforeInstall = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          allowInstall = resolve
        }),
    )
    const updater = createUpdater({ send: vi.fn(), beforeInstall, installFailed: vi.fn() })
    await tick()
    mocks.updater.emit('update-available', { version: '1.1.0' })
    mocks.updater.emit('update-downloaded')

    const installing = updater.install()
    await tick()
    expect(beforeInstall).toHaveBeenCalledOnce()
    expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled()
    allowInstall(true)
    await expect(installing).resolves.toBe(true)
    expect(mocks.updater.quitAndInstall).toHaveBeenCalledOnce()
    updater.dispose()
  })

  // electron-updater's deb install runs pkexec synchronously inside
  // quitAndInstall: a cancelled prompt or a failed dpkg emits `error` there
  // and returns without quitting, after Holi's teardown already ran.
  const failingInstall = () =>
    mocks.updater.quitAndInstall.mockImplementation(() => {
      mocks.updater.emit('error', new Error('pkexec: authorization dismissed'))
    })

  it('reports a restart-to-update whose installer fails, so Holi can still exit', async () => {
    const installFailed = vi.fn()
    const updater = createUpdater({ send: vi.fn(), beforeInstall: async () => true, installFailed })
    await tick()
    mocks.updater.emit('update-available', { version: '1.1.0' })
    mocks.updater.emit('update-downloaded')
    failingInstall()

    await expect(updater.install()).resolves.toBe(false)

    expect(installFailed).toHaveBeenCalledExactlyOnceWith('pkexec: authorization dismissed')
    updater.dispose()
  })

  it('reports an install on quit whose installer fails, and keeps the quit', async () => {
    const installFailed = vi.fn()
    const updater = createUpdater({ send: vi.fn(), beforeInstall: async () => true, installFailed })
    await tick()
    mocks.updater.emit('update-available', { version: '1.1.0' })
    mocks.updater.emit('update-downloaded')
    failingInstall()

    expect(updater.installOnQuit()).toBe(true)

    expect(installFailed).toHaveBeenCalledExactlyOnceWith('pkexec: authorization dismissed')
    updater.dispose()
  })

  it('does not report a failure for an installer that starts', async () => {
    const installFailed = vi.fn()
    const updater = createUpdater({ send: vi.fn(), beforeInstall: async () => true, installFailed })
    await tick()
    mocks.updater.emit('update-available', { version: '1.1.0' })
    mocks.updater.emit('update-downloaded')

    await expect(updater.install()).resolves.toBe(true)
    // A later error (a background check, say) is not the install failing.
    mocks.updater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'))

    expect(installFailed).not.toHaveBeenCalled()
    updater.dispose()
  })

  it('does not install a ready candidate staged on the previous channel', async () => {
    const updater = createUpdater({
      send: vi.fn(),
      beforeInstall: async () => true,
      installFailed: vi.fn(),
    })
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
    const updater = createUpdater({
      send: vi.fn(),
      beforeInstall: async () => true,
      installFailed: vi.fn(),
    })
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
    const updater = createUpdater({
      send: vi.fn(),
      beforeInstall: async () => true,
      installFailed: vi.fn(),
    })
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

describe('updater default channel', () => {
  const originalPlatform = process.platform
  const onPlatform = (platform: NodeJS.Platform) =>
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  const create = () =>
    createUpdater({ send: vi.fn(), beforeInstall: async () => true, installFailed: vi.fn() })

  afterEach(() => {
    onPlatform(originalPlatform)
  })

  it.each([
    ['win32', 'dev', 'dev'],
    ['darwin', 'stable', 'latest'],
    ['linux', 'stable', 'latest'],
  ] as const)(
    'follows the %s default when no channel was chosen',
    async (platform, channel, feed) => {
      onPlatform(platform)
      mocks.read.mockResolvedValue({ enabled: true, channel: null })
      const updater = create()
      await tick()
      expect(updater.status().channel).toBe(channel)
      expect(mocks.updater.channel).toBe(feed)
      updater.dispose()
    },
  )

  it('keeps a chosen channel over the default on every platform', async () => {
    onPlatform('win32')
    mocks.read.mockResolvedValue({ enabled: true, channel: 'stable' })
    const updater = create()
    await tick()
    expect(updater.status().channel).toBe('stable')
    expect(mocks.updater.channel).toBe('latest')
    updater.dispose()
  })

  it('does not store the default when another setting changes', async () => {
    onPlatform('win32')
    mocks.read.mockResolvedValue({ enabled: true, channel: null })
    let stored: unknown = null
    mocks.update.mockImplementation(async (change) => {
      stored = change({ enabled: true, channel: null })
      return stored
    })
    const updater = create()
    await tick()
    await updater.setEnabled(false)
    expect(stored).toEqual({ enabled: false, channel: null })
    updater.dispose()
  })
})
