import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({ handlers: new Map<string, (...args: never[]) => unknown>() }))
vi.mock('electron', () => ({
  app: { isPackaged: true },
  BrowserWindow: { fromWebContents: () => null },
  dialog: {},
  ipcMain: {
    handle: (name: string, handler: (...args: never[]) => unknown) =>
      ipc.handlers.set(name, handler),
    on: vi.fn(),
  },
  nativeImage: { createFromDataURL: () => ({}) },
  nativeTheme: {},
  shell: {},
}))

import { registerIpc } from '../src/main/ipc'

const router = {
  createCaller: () => ({
    mdxTrust: { approve: async () => ({ trusted: true }) },
    other: { query: async () => ({ allowed: true }) },
  }),
} as never

describe('MDX trust IPC authorization', () => {
  beforeEach(() => {
    ipc.handlers.clear()
    registerIpc({
      router,
      rootFor: async () => null,
      trustedMdxSender: (event) =>
        event.sender === 'holi-window' && event.senderFrame === 'main-frame',
    })
  })

  it('refuses untrusted or subframe callers and permits the application main frame', async () => {
    const handle = ipc.handlers.get('holi:trpc')!
    const invoke = (sender: string, senderFrame: string) =>
      handle({ sender, senderFrame }, { path: 'mdxTrust.approve', type: 'mutation', input: {} })
    expect(await invoke('plugin-frame', 'main-frame')).toMatchObject({ ok: false })
    expect(await invoke('holi-window', 'plugin-frame')).toMatchObject({ ok: false })
    expect(await invoke('holi-window', 'main-frame')).toEqual({ ok: true, data: { trusted: true } })
  })

  it('does not apply MDX authorization to unrelated router operations', async () => {
    const handle = ipc.handlers.get('holi:trpc')!
    const answer = await handle(
      { sender: 'other', senderFrame: 'subframe' },
      { path: 'other.query', type: 'query', input: {} },
    )
    expect(answer).toEqual({ ok: true, data: { allowed: true } })
  })
})
