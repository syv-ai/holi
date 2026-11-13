import { Provider, createStore } from 'jotai'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@/test/render'
import { activeRemoteAtom, openTabAtom } from '@/plugin-api'
import type { Terminal } from '@xterm/xterm'
import { SessionTerminal } from '../renderer/session-terminal'
import { receivePtyData } from '../renderer/lib/session-terminals'

const fixture = vi.hoisted(() => ({ terminals: [] as Terminal[], send: vi.fn() }))
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
          mount.append(textarea)
        }
        term.focus = () => textarea.focus()
        term.loadAddon = () => {}
        term.registerLinkProvider = () => ({ dispose() {} })
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
  vi.unstubAllGlobals()
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
    bottom: 420,
    width: 800,
    height: 400,
    x: 10,
    y: 20,
    toJSON: () => ({}),
  } as DOMRect)

  act(() => receivePtyData({ id: 'wheel-terminal', data: '\x1b[?1049' }))
  act(() => receivePtyData({ id: 'wheel-terminal', data: 'h\x1b[?1000' }))
  act(() => receivePtyData({ id: 'wheel-terminal', data: 'h\x1b[?1006h' }))
  const wheel = (deltaY: number, deltaMode: number = WheelEvent.DOM_DELTA_PIXEL) =>
    new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY,
      deltaMode,
      clientX: 110,
      clientY: 120,
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
  expect(sentWheel()).toContain('\x1b[<65;11;7M')

  const lineUp = wheel(-1, WheelEvent.DOM_DELTA_LINE)
  const secondLineUp = wheel(-2, WheelEvent.DOM_DELTA_LINE)
  act(() => {
    mount.dispatchEvent(lineUp)
    mount.dispatchEvent(secondLineUp)
  })
  expect(sentWheel()).toContain('\x1b[<64;11;7M')
  const pageDown = wheel(1, WheelEvent.DOM_DELTA_PAGE)
  act(() => mount.dispatchEvent(pageDown))
  expect(sentWheel().filter((data) => data === '\x1b[<65;11;7M')).toHaveLength(10)
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
  act(() => receivePtyData({ id: 'wheel-terminal', data: '\x1b[?1000l' }))
  const ordinaryBuffer = wheel(80)
  act(() => mount.dispatchEvent(ordinaryBuffer))
  expect(ordinaryBuffer.defaultPrevented).toBe(false)
  expect(sentWheel()).toHaveLength(writesBeforeDisable)
  ui.unmount()
  const disposed = wheel(80)
  act(() => mount.dispatchEvent(disposed))
  expect(disposed.defaultPrevented).toBe(false)
})
