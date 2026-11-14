import { Provider, createStore } from 'jotai'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@/test/render'
import { activeRemoteAtom, openTabAtom } from '@/plugin-api'
import type { Terminal } from '@xterm/xterm'
import { SessionTerminal } from '../renderer/session-terminal'
import { receivePtyData } from '../renderer/lib/session-terminals'

const fixture = vi.hoisted(() => ({
  terminals: [] as Terminal[],
  send: vi.fn(),
  openExternal: vi.fn(),
  linkProvider: null as {
    provideLinks: (y: number, callback: (links: unknown) => void) => void
  } | null,
}))
vi.mock('../renderer/agent-cap', () => ({ agentCap: { attach: async () => '' } }))
vi.mock('@/lib/terminal-theme', () => ({
  terminalTheme: () => ({}),
  watchTerminalTheme: () => () => {},
  suppressTerminalColorQueries: () => () => {},
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}))
vi.mock('@xterm/xterm', async (original) => {
  const { Terminal: NativeTerminal } = await original<typeof import('@xterm/xterm')>()
  return {
    Terminal: class {
      constructor(options: ConstructorParameters<typeof NativeTerminal>[0]) {
        const term = new NativeTerminal(options)
        // jsdom has no canvas layout. Only replace the DOM adapter; xterm's
        // actual parser, options, buffer, writes and onData remain untouched.
        const textarea = document.createElement('textarea')
        Object.defineProperty(term, 'textarea', { get: () => textarea })
        term.open = (mount) => {
          const screen = document.createElement('div')
          screen.className = 'xterm-screen'
          mount.append(screen, textarea)
          term.resize(98, 24)
          vi.spyOn(screen, 'getBoundingClientRect').mockReturnValue({
            left: 10,
            top: 20,
            right: 794.5,
            bottom: 404.25,
            width: 784.5,
            height: 384.25,
            x: 10,
            y: 20,
            toJSON: () => ({}),
          } as DOMRect)
        }
        term.focus = () => textarea.focus()
        term.loadAddon = () => {}
        term.registerLinkProvider = (provider) => {
          fixture.linkProvider = provider
          return { dispose() {} }
        }
        fixture.terminals.push(term)
        return term
      }
    },
  }
})

afterEach(() => {
  cleanup()
  fixture.terminals.length = 0
  fixture.send.mockClear()
  fixture.openExternal.mockClear()
  fixture.linkProvider = null
  vi.unstubAllGlobals()
})

test('native OSC 8 HTTP links activate through the external browser helper', async () => {
  vi.stubGlobal('holi', {
    plugin: { send: fixture.send },
    openExternal: fixture.openExternal,
  })
  const store = createStore()
  store.set(activeRemoteAtom, 'fixture/links')
  store.set(openTabAtom, { kind: 'surface', surface: 'agent', id: 'links-terminal' })
  const view = (visible: boolean) => (
    <Provider store={store}>
      <SessionTerminal terminalId="links-terminal" provider="pi" visible={visible} />
    </Provider>
  )
  const ui = render(view(true))
  await waitFor(() => expect(fixture.terminals).toHaveLength(1))
  const handler = fixture.terminals[0]!.options.linkHandler
  const preventDefault = vi.fn()
  const activate = (button = 0, metaKey = true) =>
    handler?.activate(
      { preventDefault, button, metaKey } as unknown as MouseEvent,
      'https://example.com/docs',
      {
        start: { x: 1, y: 1 },
        end: { x: 28, y: 1 },
      },
    )
  activate(0, false)
  activate(2, true)
  expect(preventDefault).not.toHaveBeenCalled()
  expect(fixture.openExternal).not.toHaveBeenCalled()
  activate()
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(fixture.openExternal).toHaveBeenCalledWith('https://example.com/docs')

  ui.rerender(view(false))
  activate()
  expect(fixture.openExternal).toHaveBeenCalledTimes(1)
})

test('a hidden retained terminal answers real xterm protocol queries without enabling its textarea', async () => {
  vi.stubGlobal('holi', { plugin: { send: fixture.send } })
  const store = createStore()
  store.set(activeRemoteAtom, 'fixture/protocol')
  store.set(openTabAtom, { kind: 'surface', surface: 'agent', id: 'protocol-terminal' })
  const view = (visible: boolean) => (
    <Provider store={store}>
      <SessionTerminal terminalId="protocol-terminal" provider="pi" visible={visible} />
    </Provider>
  )
  const ui = render(view(true))
  await waitFor(() => expect(fixture.terminals).toHaveLength(1))
  ui.rerender(view(false))
  act(() => receivePtyData({ id: 'protocol-terminal', data: '\x1b[6n' }))
  await waitFor(() => {
    expect(
      fixture.send.mock.calls.some(
        ([, event]) => event.name === 'pty-write' && /^\x1b\[\d+;\d+R$/.test(event.payload.data),
      ),
    ).toBe(true)
  })
  expect(fixture.terminals[0]!.textarea).toBeDisabled()
  expect(fixture.terminals[0]!.options.disableStdin).toBe(false)
})

test('registered provider finds and activates a plaintext file URL wrapped by xterm', async () => {
  const openPath = vi.fn()
  vi.stubGlobal('holi', { plugin: { send: fixture.send }, openPath })
  const store = createStore()
  store.set(activeRemoteAtom, 'fixture/wrapped-links')
  store.set(openTabAtom, { kind: 'surface', surface: 'agent', id: 'wrapped-terminal' })
  const ui = render(
    <Provider store={store}>
      <SessionTerminal terminalId="wrapped-terminal" provider="claude" visible />
    </Provider>,
  )
  await waitFor(() => expect(fixture.linkProvider).not.toBeNull())
  const terminal = fixture.terminals[0]!
  terminal.resize(80, 24)
  const url = 'file:///tmp/a%20long%20report.pdf'
  act(() => receivePtyData({ id: 'wrapped-terminal', data: `${'x'.repeat(70)}${url}` }))
  await waitFor(() => expect(terminal.buffer.active.getLine(1)?.isWrapped).toBe(true))
  let links: Array<{
    range: { start: { x: number; y: number }; end: { x: number; y: number } }
    text: string
    activate: (event: MouseEvent, text: string) => void
  }> = []
  act(() => fixture.linkProvider!.provideLinks(2, (value) => (links = value as typeof links)))
  expect(links).toHaveLength(1)
  expect(links[0]!.text).toBe(url)
  expect(links[0]!.range.start.y).toBe(1)
  expect(links[0]!.range.end.y).toBe(2)
  links[0]!.activate({ button: 0, metaKey: true } as MouseEvent, url)
  expect(openPath).toHaveBeenCalledWith('/tmp/a long report.pdf')
  ui.unmount()
})

test('Pi fullscreen wheel routing sends accumulated native SGR events only in mouse mode', async () => {
  vi.stubGlobal('holi', { plugin: { send: fixture.send } })
  const store = createStore()
  store.set(activeRemoteAtom, 'fixture/wheel')
  store.set(openTabAtom, { kind: 'surface', surface: 'agent', id: 'wheel-terminal' })
  const view = (visible: boolean) => (
    <Provider store={store}>
      <SessionTerminal terminalId="wheel-terminal" provider="pi" visible={visible} />
    </Provider>
  )
  const ui = render(view(true))
  await waitFor(() => expect(fixture.terminals).toHaveLength(1))
  const mount = ui.container.querySelector('[data-session-terminal] > div')!
  vi.spyOn(mount, 'getBoundingClientRect').mockReturnValue({
    left: 10,
    top: 20,
    right: 810,
    bottom: 419,
    width: 800,
    height: 399,
    x: 10,
    y: 20,
    toJSON: () => ({}),
  } as DOMRect)

  act(() => receivePtyData({ id: 'wheel-terminal', data: '\x1b[?1049' }))
  act(() => receivePtyData({ id: 'wheel-terminal', data: 'h\x1b[?1000' }))
  act(() => receivePtyData({ id: 'wheel-terminal', data: 'h\x1b[?1006h' }))
  const beforeXtermProcessesOutput = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    deltaY: 40,
    clientX: 51,
    clientY: 37,
  })
  act(() => mount.dispatchEvent(beforeXtermProcessesOutput))
  expect(beforeXtermProcessesOutput.defaultPrevented).toBe(false)
  await waitFor(() => expect(fixture.terminals[0]!.buffer.active.type).toBe('alternate'))
  const wheel = (deltaY: number, deltaMode: number = WheelEvent.DOM_DELTA_PIXEL) =>
    new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY,
      deltaMode,
      clientX: 51,
      clientY: 37,
    })
  const first = wheel(20)
  const second = wheel(20)
  act(() => {
    mount.dispatchEvent(first)
    mount.dispatchEvent(second)
  })
  expect(first.defaultPrevented).toBe(true)
  expect(second.defaultPrevented).toBe(true)
  const sentWheel = () => fixture.send.mock.calls.map(([, event]) => event.payload?.data)
  expect(sentWheel()).toContain('\x1b[<65;6;2M')
  const topLeft = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    deltaY: 40,
    clientX: 11,
    clientY: 21,
  })
  act(() => mount.dispatchEvent(topLeft))
  expect(sentWheel()).toContain('\x1b[<65;1;1M')
  const scrollbarGap = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    deltaY: 40,
    clientX: 795,
    clientY: 37,
  })
  const writesBeforeScrollbar = sentWheel().length
  act(() => mount.dispatchEvent(scrollbarGap))
  expect(scrollbarGap.defaultPrevented).toBe(false)
  expect(sentWheel()).toHaveLength(writesBeforeScrollbar)

  const lineUp = wheel(-1, WheelEvent.DOM_DELTA_LINE)
  const secondLineUp = wheel(-2, WheelEvent.DOM_DELTA_LINE)
  act(() => {
    mount.dispatchEvent(lineUp)
    mount.dispatchEvent(secondLineUp)
  })
  expect(sentWheel()).toContain('\x1b[<64;6;2M')
  const pageDown = wheel(1, WheelEvent.DOM_DELTA_PAGE)
  act(() => mount.dispatchEvent(pageDown))
  expect(sentWheel().filter((data) => data === '\x1b[<65;6;2M')).toHaveLength(10)
  const zoom = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    deltaY: 80,
    ctrlKey: true,
    clientX: 110,
    clientY: 120,
  })
  const writesBeforeZoom = sentWheel().length
  act(() => mount.dispatchEvent(zoom))
  expect(zoom.defaultPrevented).toBe(false)
  expect(sentWheel()).toHaveLength(writesBeforeZoom)

  ui.rerender(view(false))
  const hidden = wheel(80)
  act(() => mount.dispatchEvent(hidden))
  expect(hidden.defaultPrevented).toBe(false)
  ui.rerender(view(true))

  const writesBeforeDisable = sentWheel().length
  act(() => receivePtyData({ id: 'wheel-terminal', data: '\x1b[?1000l\x1b[?1049l' }))
  await waitFor(() => expect(fixture.terminals[0]!.buffer.active.type).toBe('normal'))
  const ordinaryBuffer = wheel(80)
  act(() => mount.dispatchEvent(ordinaryBuffer))
  expect(ordinaryBuffer.defaultPrevented).toBe(false)
  expect(sentWheel()).toHaveLength(writesBeforeDisable)
  ui.unmount()
  const disposed = wheel(80)
  act(() => mount.dispatchEvent(disposed))
  expect(disposed.defaultPrevented).toBe(false)
})
