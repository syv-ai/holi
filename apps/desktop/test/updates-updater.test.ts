import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  updater: new EventEmitter() as EventEmitter & Record<string, any>,
  read: vi.fn(),
  update: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/holi-test', isPackaged: true, getVersion: () => '1.0.0', on: vi.fn(), removeListener: vi.fn() },
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
  it('initializes the stable feed as latest before the first check and preserves quit installation', async () => {
    const send = vi.fn()
    const updater = createUpdater({ send, beforeInstall: async () => true })
    await tick()
    expect(mocks.updater.channel).toBe('latest')
    expect(mocks.updater.autoInstallOnAppQuit).toBe(false)
    const downloadPromise = Promise.resolve()
    mocks.updater.checkForUpdates.mockResolvedValue({ downloadPromise, cancellationToken: { cancel: vi.fn() } })
    await updater.check()
    mocks.updater.emit('update-available', { version: '1.1.0' })
    mocks.updater.emit('update-downloaded')
    expect(mocks.updater.autoInstallOnAppQuit).toBe(true)
    expect(updater.status()).toMatchObject({ state: 'ready', availableVersion: '1.1.0' })
    updater.dispose()
  })

  it('waits for persisted preferences before checking and migrates unknown preferences to stable', async () => {
    let resolveRead!: (value: { enabled: boolean; channel: 'stable' }) => void
    mocks.read.mockReturnValue(new Promise((resolve) => { resolveRead = resolve }))
    const updater = createUpdater({ send: vi.fn(), beforeInstall: async () => true })
    const check = updater.check()
    await tick()
    expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled()
    resolveRead({ enabled: true, channel: 'stable' })
    mocks.updater.checkForUpdates.mockResolvedValue({ downloadPromise: Promise.resolve(), cancellationToken: { cancel: vi.fn() } })
    await check
    expect(mocks.updater.channel).toBe('latest')
    expect(mocks.updater.checkForUpdates).toHaveBeenCalledOnce()
    updater.dispose()
  })

  it('cancels and drains the previous channel download before checking the selected channel', async () => {
    const updater = createUpdater({ send: vi.fn(), beforeInstall: async () => true })
    await tick()
    let finish!: () => void
    const downloadPromise = new Promise<void>((resolve) => { finish = resolve })
    const cancel = vi.fn()
    mocks.updater.checkForUpdates.mockResolvedValue({ downloadPromise, cancellationToken: { cancel } })
    const priorCheck = updater.check()
    await tick()
    const switching = updater.setChannel('dev')
    await tick()
    expect(cancel).toHaveBeenCalledOnce()
    expect(mocks.updater.checkForUpdates).toHaveBeenCalledOnce()
    finish()
    await priorCheck
    mocks.updater.checkForUpdates.mockResolvedValue({ downloadPromise: Promise.resolve(), cancellationToken: { cancel: vi.fn() } })
    await switching
    expect(mocks.updater.channel).toBe('dev')
    expect(mocks.updater.checkForUpdates).toHaveBeenCalledTimes(2)
    expect(updater.status().channel).toBe('dev')
    updater.dispose()
  })
})
