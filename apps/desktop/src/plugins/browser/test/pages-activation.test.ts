import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createPluginHost, type OpenVault } from '../../../main/plugin-host/host'
import { createCapabilityRegistry } from '../../../main/capabilities/registry'
import { noCoreServices } from '../../../main/capabilities/services'
import type { PluginEvent } from '../../../main/plugin-host/events'
import { browserMain } from '../main/index'

const native = vi.hoisted(() => ({ views: [] as any[], menus: [] as any[] }))
vi.mock('electron', () => {
  class WebContentsView {
    webContents = Object.assign(new EventTarget(), {
      isDestroyed: () => false,
      getURL: () => 'https://example.com/',
      getTitle: () => 'Example',
      isLoading: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      setWindowOpenHandler: vi.fn(),
      close: vi.fn(),
      cut: vi.fn(),
      copy: vi.fn(),
      paste: vi.fn(),
      reload: vi.fn(),
      loadURL: vi.fn(async () => {}),
      executeJavaScriptInIsolatedWorld: vi.fn(
        async (_world: number, scripts: { code: string }[]) => {
          const code = scripts.at(-1)?.code ?? ''
          if (code.includes('__holiPage.vim.rearm()')) return 'document-nonce'
          if (code.includes('__holiPage.vim.mode()')) return { revision: 1, mode: 'insert' }
          if (code.includes('__holiPage.vim.configure(') || code.includes('__holiPage.vim.reset('))
            return true
          return undefined
        },
      ),
      on: vi.fn(function (this: any, event: string, callback: (...args: any[]) => void) {
        this.listeners ??= new Map()
        this.listeners.set(event, callback)
      }),
      emit: function (this: any, event: string, ...args: any[]) {
        this.listeners?.get(event)?.({ preventDefault: vi.fn() }, ...args)
      },
    })
    setBackgroundColor = vi.fn()
    bounds = { x: 0, y: 0, width: 0, height: 0 }
    setBounds = vi.fn((bounds: typeof this.bounds) => {
      this.bounds = { ...bounds }
    })
    getBounds = vi.fn(() => ({ ...this.bounds }))
    constructor() {
      native.views.push(this)
    }
  }
  return {
    WebContentsView,
    app: { getName: () => 'Holi' },
    session: {
      fromPartition: () => ({
        setUserAgent: vi.fn(),
        getUserAgent: () => 'test',
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
      }),
    },
    Menu: {
      buildFromTemplate: (items: any[]) => {
        const menu = { items, popup: vi.fn(), closePopup: vi.fn(), once: vi.fn() }
        native.menus.push(menu)
        return menu
      },
    },
    clipboard: { writeText: vi.fn() },
    shell: { openExternal: vi.fn() },
  }
})

const win = () => {
  const children: any[] = []
  return {
    children,
    isDestroyed: () => false,
    isVisible: () => true,
    contentView: {
      addChildView: (view: any) => children.push(view),
      removeChildView: (view: any) => {
        const at = children.indexOf(view)
        if (at >= 0) children.splice(at, 1)
      },
    },
    webContents: { focus: vi.fn(), getZoomFactor: () => 1 },
  } as any
}

describe('browser page activation', () => {
  beforeEach(() => {
    native.views.length = 0
    native.menus.length = 0
  })

  it('does not resurrect a discovery after its native request was cleared', async () => {
    const { createPages } = await import('../main/pages')
    const window = win()
    const modes: { nonce: string; attachment: string }[] = []
    const pages = createPages({
      window: () => window,
      presentationLease: () => () => true,
      changed: () => {},
      address: () => {},
      key: () => {},
      reveal: () => {},
      vimMode: (_id, snapshot) => modes.push(snapshot),
    })
    await pages.open({ id: 'hints', reveal: false })
    const view = native.views[0]
    view.webContents.emit('did-finish-load')
    await new Promise<void>((resolve) => setImmediate(resolve))
    pages.place('hints', { x: 0, y: 0, width: 100, height: 100 })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const mode = modes.at(-1)!
    let resolveDiscovery!: (value: { id: string; label: string; x: number; y: number }[]) => void
    view.webContents.executeJavaScriptInIsolatedWorld.mockImplementation(
      async (_world: number, scripts: { code: string }[]) => {
        const code = scripts.at(-1)?.code ?? ''
        if (code.includes('__holiPage.hints.discover('))
          return await new Promise((resolve) => {
            resolveDiscovery = resolve
          })
        return undefined
      },
    )
    const scope = { tab: 'hints', nonce: mode.nonce, attachment: mode.attachment, request: 1 }
    const pending = pages.discoverHints(scope)
    await pages.clearHints(scope)
    resolveDiscovery([{ id: '0', label: 'Continue', x: 5, y: 6 }])
    expect(await pending).toBeNull()
    expect(await pages.discoverHints(scope)).toBeNull()
    pages.dispose()
  })

  it('fences browser Vim configuration across A-B-A attachment changes', async () => {
    const { createPages } = await import('../main/pages')
    const window = win()
    const snapshots: {
      nonce: string
      attachment: string
      revision: number
      mode: 'insert' | 'normal'
    }[] = []
    const pages = createPages({
      window: () => window,
      presentationLease: () => () => true,
      changed: () => {},
      address: () => {},
      key: () => {},
      reveal: () => {},
      vimMode: (_id, snapshot) => snapshots.push(snapshot),
    })
    await pages.open({ id: 'vim', reveal: false })
    const view = native.views[0]
    view.webContents.emit('did-finish-load')
    await new Promise<void>((resolve) => setImmediate(resolve))
    pages.place('vim', { x: 0, y: 0, width: 100, height: 100 })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const first = snapshots.at(-1)!
    await pages.configureVim('vim', true, 2, first.nonce, first.attachment)
    await pages.configureVim('vim', false, 3, first.nonce, first.attachment)
    const afterDisable = view.webContents.executeJavaScriptInIsolatedWorld.mock.calls.filter(
      ([, scripts]: [number, { code: string }[]]) =>
        scripts.at(-1)?.code.includes('__holiPage.vim.configure('),
    ).length
    await pages.configureVim('vim', true, 2, first.nonce, first.attachment)
    await pages.configureVim('vim', true, 3, first.nonce, first.attachment)
    expect(
      view.webContents.executeJavaScriptInIsolatedWorld.mock.calls.filter(
        ([, scripts]: [number, { code: string }[]]) =>
          scripts.at(-1)?.code.includes('__holiPage.vim.configure('),
      ),
    ).toHaveLength(afterDisable)
    pages.place('vim', null)
    pages.place('vim', { x: 0, y: 0, width: 100, height: 100 })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const second = snapshots.at(-1)!
    expect(second.attachment).not.toBe(first.attachment)
    const configCalls = () =>
      view.webContents.executeJavaScriptInIsolatedWorld.mock.calls.filter(
        ([, scripts]: [number, { code: string }[]]) =>
          scripts.at(-1)?.code.includes('__holiPage.vim.configure('),
      ).length
    const beforeStale = configCalls()
    await pages.configureVim('vim', true, 2, first.nonce, first.attachment)
    expect(configCalls()).toBe(beforeStale)
    await pages.configureVim('vim', true, 1, second.nonce, second.attachment)
    expect(configCalls()).toBe(beforeStale + 1)
    pages.dispose()
  })

  it('rearms ownership in one page call only for top-document navigation', async () => {
    const { createPages } = await import('../main/pages')
    const window = win()
    const snapshots = vi.fn()
    const pages = createPages({
      window: () => window,
      presentationLease: () => () => true,
      changed: () => {},
      address: () => {},
      key: () => {},
      reveal: () => {},
      vimMode: snapshots,
    })
    try {
      await pages.open({ id: 'vim', reveal: false })
      pages.place('vim', { x: 0, y: 0, width: 100, height: 100 })
      const wc = native.views[0].webContents
      wc.emit('did-navigate-in-page', 'https://example.com/#child', false)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(wc.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
      wc.emit('did-navigate-in-page', 'https://example.com/#parent', true)
      await new Promise<void>((resolve) => setImmediate(resolve))
      const calls = wc.executeJavaScriptInIsolatedWorld.mock.calls
      expect(calls[0][1][0].code).toMatch(/__holiPage\.vim\.rearm\(\)$/)
      expect(calls).toHaveLength(2)
      expect(calls[1][1][0].code).toMatch(/__holiPage\.vim\.mode\(\)$/)
      expect(snapshots).toHaveBeenCalledWith(
        'vim',
        expect.objectContaining({ nonce: 'document-nonce', mode: 'insert' }),
        expect.any(Function),
      )
    } finally {
      pages.dispose()
    }
  })

  it('requires fresh placement after hide and binds delayed actions to the exact attachment', async () => {
    const { createPages } = await import('../main/pages')
    let presentation = true
    const window = win()
    const reveal = vi.fn()
    const admitted: (() => boolean)[] = []
    const keys = vi.fn((_id: string, _key: unknown, guard?: () => boolean) => {
      if (guard) admitted.push(guard)
    })
    const pages = createPages({
      window: () => window,
      presentationLease: () => () => presentation,
      changed: () => {},
      reveal,
      address: () => {},
      key: keys,
    })
    await pages.open({ id: 'same', reveal: false })
    pages.place('same', { x: 0, y: 0, width: 100, height: 100 })
    const first = native.views[0]
    const oldPlacement = pages.placementGuard('same', () => presentation)
    first.webContents.emit('before-input-event', {
      type: 'keyDown',
      key: 'q',
      code: 'KeyQ',
      control: true,
      meta: true,
      shift: false,
      alt: false,
    })
    expect(admitted).toHaveLength(1)
    expect(window.children).toEqual([first])
    pages.place('same', null)
    expect(oldPlacement()).toBe(true)
    expect(admitted[0]!()).toBe(false)
    expect(window.children).toEqual([])
    pages.place('same', { x: 0, y: 0, width: 100, height: 100 })
    expect(window.children).toEqual([first])
    pages.close('same')
    expect(oldPlacement()).toBe(false)
    await pages.open({ id: 'same', reveal: false })
    expect(native.views).toHaveLength(2)
    pages.place('same', { x: 0, y: 0, width: 100, height: 100 })
    expect(window.children).toEqual([native.views[1]])
    pages.dispose()
  })

  it('does not revive queued popup reveal when the source tab is reattached', async () => {
    const { createPages } = await import('../main/pages')
    const window = win()
    const guards: (() => boolean)[] = []
    const pages = createPages({
      window: () => window,
      presentationLease: () => () => true,
      changed: () => {},
      address: () => {},
      key: () => {},
      reveal: (_id, guard) => {
        if (guard) guards.push(guard)
      },
    })
    await pages.open({ id: 'source', reveal: false })
    pages.place('source', { x: 0, y: 0, width: 100, height: 100 })
    native.views[0].webContents.setWindowOpenHandler.mock.calls[0][0]({
      url: 'https://example.com/new',
    })
    expect(guards).toHaveLength(1)
    expect(guards[0]!()).toBe(true)
    pages.place('source', null)
    pages.place('source', { x: 0, y: 0, width: 100, height: 100 })
    expect(guards[0]!()).toBe(false)
    pages.dispose()
  })

  it('keeps hidden page popups vault-bound without granting presentation authority', async () => {
    const { createPages } = await import('../main/pages')
    const reveal = vi.fn()
    const pages = createPages({
      window: () => null,
      changed: () => {},
      address: () => {},
      key: () => {},
      reveal,
    })
    await pages.open({ id: 'hidden', reveal: false })
    const popup = native.views[0].webContents.setWindowOpenHandler.mock.calls[0][0]
    expect(popup({ url: 'https://example.com/new' })).toEqual({ action: 'deny' })
    expect(pages.list()).toHaveLength(2)
    expect(reveal).not.toHaveBeenCalled()
    pages.dispose()
    popup({ url: 'https://example.com/stale' })
    expect(pages.list()).toEqual([])
  })

  it('invalidates presentation callbacks on departure and disposes only its own child view', async () => {
    const { createPages } = await import('../main/pages')
    let display: ((remote: string | null) => void) | undefined
    let presentation = true
    const window = win()
    const pages = createPages({
      window: () => window,
      presentationLease: () => () => presentation,
      onDisplayChange: (cb) => {
        display = cb
        return () => {
          display = undefined
        }
      },
      changed: () => {},
      reveal: () => {},
      address: () => {},
      key: () => {},
    })
    await pages.open({ id: 'tab', reveal: false })
    pages.place('tab', { x: 0, y: 0, width: 100, height: 100 })
    const ours = native.views[0]
    const other = {}
    window.children.push(other)
    presentation = false
    display?.('B')
    expect(window.children).toEqual([other])
    presentation = true
    pages.place('tab', { x: 0, y: 0, width: 100, height: 100 })
    expect(window.children).toEqual([other, ours])
    pages.dispose()
    expect(window.children).toEqual([other])
    expect(display).toBeUndefined()
  })
})

const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
})

async function hostRig() {
  const root = await mkdtemp(join(tmpdir(), 'holi-browser-host-'))
  const roots = { A: join(root, 'a'), B: join(root, 'b') }
  for (const dir of Object.values(roots)) {
    await mkdir(join(dir, '.holi/settings'), { recursive: true })
    await writeFile(join(dir, '.holi/settings/plugins.yaml'), 'plugins:\n  browser: true\n')
  }
  const window = win()
  const registry = createCapabilityRegistry()
  const listeners = new Set<(message: unknown) => void>()
  const sent: PluginEvent[] = []
  let gate: { wait: Promise<void>; entered(): void } | undefined
  const host = createPluginHost({
    plugins: [browserMain],
    registry,
    userData: root,
    coreSeeds: [],
    active: () => null,
    rootFor: async (remote) => {
      const pending = gate
      if (pending) {
        pending.entered()
        await pending.wait
      }
      return roots[remote as keyof typeof roots] ?? null
    },
    events: {
      send: (_channel, event) => {
        sent.push(event)
      },
      listen: (_channel, handler) => {
        listeners.add(handler)
        return () => {
          listeners.delete(handler)
        }
      },
      liveRemote: () => host.displayed(),
    },
    openAppDoor: () => {
      throw new Error('unused app door')
    },
    route: () => () => {},
    binDir: () => root,
    githubToken: () => null,
    frameOrigin: () => () => {},
    notify: () => false,
    focused: () => false,
    window: () => window,
  })
  disposers.push(async () => {
    await host.stopAll()
    await rm(root, { recursive: true, force: true })
  })
  for (const remote of ['A', 'B'] as const) {
    const vault: OpenVault = {
      remote,
      root: roots[remote],
      pause: () => {},
      resume: () => {},
      commitNow: async () => null,
      repo: { head: async () => null },
    }
    await host.reconcile(vault, 'open')
    expect(host.failures(remote)).toEqual({})
  }
  host.setDisplayed('A')
  const call = async (remote: 'A' | 'B', name: string, params: unknown) =>
    registry.run(
      `browser.${name}`,
      'cli',
      {
        remote,
        root: roots[remote],
        bundle: null,
        core: noCoreServices(),
        claims: async () => [],
        snapshot: async () => {
          throw new Error('unused snapshot')
        },
      },
      params,
    )
  const place = (remote: string, rect: unknown) => {
    for (const listener of listeners)
      listener({ remote, name: 'place', payload: { id: 'same', rect } })
  }
  const block = () => {
    let release!: () => void
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    gate = {
      wait: new Promise<void>((resolve) => {
        release = resolve
      }),
      entered,
    }
    return {
      waiting,
      release: () => {
        gate = undefined
        release()
      },
    }
  }
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
  return { host, window, sent, call, place, block, tick, listeners }
}

const box = { x: 0, y: 0, width: 100, height: 100 }
const command = {
  type: 'keyDown',
  key: 'w',
  code: 'KeyW',
  meta: true,
  control: true,
  alt: false,
  shift: false,
}

describe('production browser activation and host event queues', () => {
  beforeEach(() => {
    native.views.length = 0
    native.menus.length = 0
  })
  it('preserves ordered queued placement updates and overlay hide/restore', async () => {
    const h = await hostRig()
    await h.call('A', 'open', { reopen: 'same', shown: true })
    await h.tick()
    const gate = h.block()
    h.place('A', box)
    h.place('A', { ...box, width: 200 })
    await gate.waiting
    gate.release()
    await h.tick()
    expect(h.window.children).toEqual([native.views[0]])
    expect(native.views[0].setBounds).toHaveBeenLastCalledWith({ ...box, width: 200 })
    const overlay = h.block()
    h.place('A', null)
    h.place('A', { ...box, width: 300 })
    await overlay.waiting
    overlay.release()
    await h.tick()
    expect(h.window.children).toEqual([native.views[0]])
    expect(native.views[0].setBounds).toHaveBeenLastCalledWith({ ...box, width: 300 })
  })

  it.each([box, null])(
    'rejects a queued placement for a closed same-id incarnation: %j',
    async (rect) => {
      const h = await hostRig()
      await h.call('A', 'open', { reopen: 'same', shown: true })
      await h.tick()
      const gate = h.block()
      h.place('A', rect)
      await gate.waiting
      await h.call('A', 'close', { tab: 'same' })
      await h.call('A', 'open', { reopen: 'same', shown: true })
      gate.release()
      await h.tick()
      expect(h.window.children).toEqual([])
      expect(native.views[1].setBounds).toHaveBeenCalledTimes(1)
      h.place('A', box)
      await h.tick()
      expect(h.window.children).toEqual([native.views[1]])
    },
  )

  it('drops queued key and address actions on hide, preserves bound hidden data, and requires fresh placement', async () => {
    const h = await hostRig()
    await h.call('A', 'open', { reopen: 'same', shown: true })
    await h.tick()
    h.place('A', box)
    await h.tick()
    const view = native.views[0]
    const gate = h.block()
    view.webContents.emit('before-input-event', command)
    view.webContents.emit('before-input-event', { ...command, key: 'l' })
    await gate.waiting
    h.place('A', null)
    // Display departure synchronously hides independently of the blocked event queue.
    h.host.setDisplayed('B')
    h.host.setDisplayed('A')
    gate.release()
    await h.tick()
    expect(h.sent.filter((e) => ['key', 'address'].includes(e.name))).toEqual([])
    expect(h.window.children).toEqual([])
    view.webContents.emit('before-input-event', command)
    expect(h.window.webContents.focus).toHaveBeenCalledTimes(1)
    h.host.setDisplayed('B')
    await h.call('A', 'open', { reopen: 'hidden', shown: true })
    await h.tick()
    expect(h.sent.some((e) => e.remote === 'A' && e.name === 'tabs')).toBe(true)
    await h.call('B', 'open', { reopen: 'same', shown: true })
    h.place('B', box)
    await h.tick()
    const b = h.window.children[0]
    await h.host.stop('A')
    expect(h.window.children).toEqual([b])
    expect((await h.call('B', 'tabs', {})).value).toHaveLength(1)
  })

  it('invalidates saved menu actions and popup reveal leases when an attachment ends', async () => {
    const h = await hostRig()
    await h.call('A', 'open', { reopen: 'same', shown: true })
    await h.tick()
    h.place('A', box)
    await h.tick()
    const view = native.views[0]
    view.webContents.emit('context-menu', {
      linkURL: 'https://example.com/new',
      isEditable: true,
      selectionText: '',
    })
    const menu = native.menus[0]
    h.place('A', null)
    await h.tick()
    expect(menu.closePopup).toHaveBeenCalled()
    h.place('A', box)
    await h.tick()
    for (const item of menu.items) item.click?.()
    expect(view.webContents.cut).not.toHaveBeenCalled()
    expect(view.webContents.copy).not.toHaveBeenCalled()
    expect(view.webContents.paste).not.toHaveBeenCalled()
    const gate = h.block()
    const popup = view.webContents.setWindowOpenHandler.mock.calls[0][0]
    popup({ url: 'https://example.com/new' })
    await gate.waiting
    h.host.setDisplayed('B')
    h.host.setDisplayed('A')
    gate.release()
    await h.tick()
    expect(h.sent.filter((e) => e.name === 'reveal')).toEqual([])
  })
})
