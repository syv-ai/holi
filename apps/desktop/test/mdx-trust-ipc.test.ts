import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  listeners: new Map<string, (...args: never[]) => unknown>(),
  effects: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => '/tmp' },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  ipcMain: {
    handle: (name: string, handler: (...args: never[]) => unknown) =>
      ipc.handlers.set(name, handler),
    on: (name: string, listener: (...args: never[]) => unknown) =>
      ipc.listeners.set(name, listener),
    removeListener: (name: string) => ipc.listeners.delete(name),
  },
  nativeImage: { createFromDataURL: () => ({ isEmpty: () => false }) },
  nativeTheme: {
    set themeSource(_value: string) {
      ipc.effects()
    },
  },
  shell: { openExternal: ipc.effects, showItemInFolder: ipc.effects },
}))

import { registerIpc, listenForPluginMessages, createRendererFlushChannel } from '../src/main/ipc'
import { requestFlush } from '../src/main/flush'
import { isApplicationSender } from '../src/main/application-sender'

const entry = 'file:///application/index.html'
const mainFrame = { url: entry, parent: null }
const currentContents = { isDestroyed: () => false, mainFrame }
const validEvent = { sender: currentContents, senderFrame: mainFrame }
const foreignEvent = { sender: {}, senderFrame: mainFrame }
const router = {
  createCaller: () => ({
    mdxTrust: { approve: async () => ({ trusted: true }) },
    other: { query: async () => ({ allowed: true }) },
  }),
} as never

const validOp = { path: 'other.query', type: 'query', input: {} }

describe('application IPC authorization', () => {
  beforeEach(() => {
    ipc.handlers.clear()
    ipc.listeners.clear()
    ipc.effects.mockClear()
    registerIpc({
      router,
      rootFor: async () => null,
      authorizeSender: (event) => isApplicationSender(event, currentContents as never, entry),
    })
  })

  it('refuses every invoke before router or native side effects and preserves router envelopes', async () => {
    const event = foreignEvent
    expect(await ipc.handlers.get('holi:trpc')!(event, validOp)).toMatchObject({ ok: false })
    for (const channel of [
      'holi:openExternal',
      'holi:openPath',
      'holi:showSaveDialog',
      'holi:chooseFolder',
    ]) {
      await expect(
        Promise.resolve().then(() => ipc.handlers.get(channel)!(event, 'https://example.com')),
      ).rejects.toThrow('current Holi')
    }
    for (const channel of ['holi:appearance', 'holi:dockIcon', 'holi:startDrag']) {
      ipc.listeners.get(channel)!(event, 'dark')
    }
    expect(ipc.effects).not.toHaveBeenCalled()
  })

  it('guards plugin event subscriptions and removes them on disposal', () => {
    const received = vi.fn()
    const stop = listenForPluginMessages('plugin:fixture', received, (event) =>
      isApplicationSender(event, currentContents as never, entry),
    )
    ipc.listeners.get('plugin:fixture')!(foreignEvent, { payload: 'foreign' })
    expect(received).not.toHaveBeenCalled()
    ipc.listeners.get('plugin:fixture')!(validEvent, { payload: 'owned' })
    expect(received).toHaveBeenCalledExactlyOnceWith({ payload: 'owned' })
    stop()
    expect(ipc.listeners.has('plugin:fixture')).toBe(false)
  })

  it('guards flush acknowledgements and preserves request correlation', async () => {
    const send = vi.fn()
    const contents = { ...currentContents, send }
    const win = { isDestroyed: () => false, webContents: contents }
    const event = { sender: contents, senderFrame: mainFrame }
    const pending = requestFlush(
      createRendererFlushChannel(win as never, (value) =>
        isApplicationSender(value, contents as never, entry),
      ),
    )
    const id = send.mock.calls[0]![1].id
    const answer = ipc.listeners.get('vault:flush-done')!
    answer(foreignEvent, id)
    answer(event, 'wrong-id')
    answer(event, id)
    expect(await pending).toBe('flushed')
    expect(ipc.listeners.has('vault:flush-done')).toBe(false)
  })

  it('never reads destroyed target getters when a new window sends an acknowledgement', () => {
    let destroyed = false
    const win = {
      isDestroyed: () => destroyed,
      get webContents() {
        if (destroyed) throw new Error('Object has been destroyed')
        return currentContents
      },
    }
    const received = vi.fn()
    const stop = createRendererFlushChannel(win as never, () => true).onDone(received)
    destroyed = true
    expect(() => ipc.listeners.get('vault:flush-done')!(foreignEvent, 'request')).not.toThrow()
    expect(received).not.toHaveBeenCalled()
    stop()
  })

  it('keeps authorized router and native operations available', async () => {
    expect(await ipc.handlers.get('holi:trpc')!(validEvent, validOp)).toEqual({
      ok: true,
      data: { allowed: true },
    })
    await ipc.handlers.get('holi:openExternal')!(validEvent, 'https://example.com')
    expect(ipc.effects).toHaveBeenCalledOnce()
  })
})
