import { beforeEach, describe, expect, it, vi } from 'vitest'

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
      on: vi.fn(function (this: any, event: string, callback: (...args: any[]) => void) {
        this.listeners ??= new Map()
        this.listeners.set(event, callback)
      }),
      emit: function (this: any, event: string, ...args: any[]) {
        this.listeners?.get(event)?.({ preventDefault: vi.fn() }, ...args)
      },
    })
    setBackgroundColor = vi.fn()
    setBounds = vi.fn()
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
    expect(oldPlacement()).toBe(false)
    expect(admitted[0]!()).toBe(false)
    expect(window.children).toEqual([])
    pages.place('same', { x: 0, y: 0, width: 100, height: 100 })
    expect(window.children).toEqual([first])
    pages.close('same')
    await pages.open({ id: 'same', reveal: false })
    expect(native.views).toHaveLength(2)
    pages.place('same', { x: 0, y: 0, width: 100, height: 100 })
    expect(window.children).toEqual([native.views[1]])
    pages.dispose()
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
