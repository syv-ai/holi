import { Provider, createStore } from 'jotai'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@/test/render'
import {
  activeRemoteAtom,
  openTabAtom,
  sessionAtom,
  discoverHostHintTargets,
  activateHostHint,
  captureHostHintAdapters,
} from '@/plugin-api'
import { agentSessionsAtom, agentTerminalsAtom } from '../renderer/state/sessions'
import { WebLinksAddon } from '@xterm/addon-web-links'
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
          const rect = {
            left: 10,
            top: 20,
            right: 794.5,
            bottom: 404.25,
            width: 784.5,
            height: 384.25,
            x: 10,
            y: 20,
            toJSON: () => ({}),
          } as DOMRect
          vi.spyOn(screen, 'getBoundingClientRect').mockReturnValue(rect)
          vi.spyOn(mount, 'getBoundingClientRect').mockReturnValue(rect)
          Object.defineProperty(document, 'elementFromPoint', {
            configurable: true,
            value: () => screen,
          })
        }
        term.focus = () => textarea.focus()
        const loadAddon = term.loadAddon.bind(term)
        term.loadAddon = (addon) => {
          if (addon instanceof WebLinksAddon) loadAddon(addon)
        }
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
  delete (document as Partial<Document>).elementFromPoint
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
  const url = `file:///tmp/${'a'.repeat(160)}.pdf`
  act(() => receivePtyData({ id: 'wrapped-terminal', data: `\n\n${'x'.repeat(70)}${url}` }))
  await waitFor(() => expect(terminal.buffer.active.getLine(3)?.isWrapped).toBe(true))
  const queryResults = [3, 4, 5, 6].map((y) => {
    let links: Array<{
      range: { start: { x: number; y: number }; end: { x: number; y: number } }
      text: string
      activate: (event: MouseEvent, text: string) => void
    }> = []
    act(() => fixture.linkProvider!.provideLinks(y, (value) => (links = value as typeof links)))
    return links
  })
  for (const links of queryResults) {
    expect(links).toHaveLength(1)
    expect(links[0]!.text).toBe(url)
    expect(links[0]!.range.start.y).toBe(3)
    expect(links[0]!.range.end.y).toBe(6)
  }
  queryResults[1]![0]!.activate({ button: 0, metaKey: true } as MouseEvent, url)
  expect(openPath).toHaveBeenCalledWith(`/tmp/${'a'.repeat(160)}.pdf`)
  ui.unmount()
})

test('provider returns only links intersecting the queried row for xterm link pruning', async () => {
  vi.stubGlobal('holi', { plugin: { send: fixture.send }, openPath: vi.fn() })
  const store = createStore()
  store.set(activeRemoteAtom, 'fixture/multiple-wrapped-links')
  store.set(openTabAtom, { kind: 'surface', surface: 'agent', id: 'multiple-links-terminal' })
  const ui = render(
    <Provider store={store}>
      <SessionTerminal terminalId="multiple-links-terminal" provider="claude" visible />
    </Provider>,
  )
  await waitFor(() => expect(fixture.linkProvider).not.toBeNull())
  const terminal = fixture.terminals[0]!
  terminal.resize(40, 24)
  const first = 'file:///tmp/first.pdf'
  const second = 'file:///tmp/second.pdf'
  const text = `${first} ${'x'.repeat(70)} ${second}`
  act(() => receivePtyData({ id: 'multiple-links-terminal', data: `\n\n${text}` }))
  await waitFor(() => expect(terminal.buffer.active.getLine(3)?.isWrapped).toBe(true))

  type QueriedLink = {
    range: { start: { x: number; y: number }; end: { x: number; y: number } }
    text: string
  }
  const queried = new Map<number, QueriedLink[]>()
  for (const y of [3, 4, 5, 6]) {
    act(() =>
      fixture.linkProvider!.provideLinks(y, (value) =>
        queried.set(y, (value ?? []) as QueriedLink[]),
      ),
    )
  }
  const firstRow = [...queried].find(([, links]) => links.some((link) => link.text === first))
  const secondRow = [...queried].find(([, links]) => links.some((link) => link.text === second))
  expect(firstRow).toBeDefined()
  expect(secondRow).toBeDefined()
  expect(firstRow![0]).not.toBe(secondRow![0])
  const xtermPrune = (y: number, links: QueriedLink[]) => {
    const occupied = new Set<number>()
    return links.filter((link) => {
      const startX = link.range.start.y < y ? 1 : link.range.start.x
      const endX = link.range.end.y > y ? 40 : link.range.end.x
      for (let x = startX; x <= endX; x++) {
        if (occupied.has(x)) return false
        occupied.add(x)
      }
      return true
    })
  }
  for (const [y, links] of queried) {
    expect(links.every((link) => link.range.start.y <= y && link.range.end.y >= y)).toBe(true)
    expect(xtermPrune(y, links)).toEqual(links)
  }
  // xterm's overlap-pruner compares x coordinates on the requested row even
  // for ranges on other rows; these two full-line ranges collide at row 3.
  expect(xtermPrune(3, [firstRow![1][0]!, secondRow![1][0]!])).toHaveLength(1)
  expect(firstRow![1][0]!.range.start.y).toBe(firstRow![0])
  expect(secondRow![1][0]!.range.start.y).toBe(secondRow![0])
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

test.each(['pi', 'claude', 'unknown'] as const)(
  'only a proven Pi session exposes HTTP links, not native-looking prose (%s)',
  async (provider) => {
    vi.stubGlobal('holi', { plugin: { send: fixture.send }, openExternal: fixture.openExternal })
    const store = createStore()
    store.set(sessionAtom, { login: 'fixture-person' })
    store.set(activeRemoteAtom, 'fixture/hints')
    store.set(agentSessionsAtom, [
      {
        id: 'hint-session',
        name: 'Fixture',
        provider: provider === 'unknown' ? 'pi' : provider,
        state: 'idle',
      },
    ])
    store.set(agentTerminalsAtom, [{ id: 'hint-terminal', launchedFor: 'hint-session', title: '' }])
    const ui = render(
      <Provider store={store}>
        <SessionTerminal
          terminalId="hint-terminal"
          sessionId={provider === 'unknown' ? undefined : 'hint-session'}
          provider={provider === 'unknown' ? undefined : provider}
          visible
        />
      </Provider>,
    )
    ui.container.dataset.pane = 'hint-pane'
    await waitFor(() => expect(fixture.terminals).toHaveLength(1))
    act(() =>
      receivePtyData({
        id: 'hint-terminal',
        data: 'Approve tool? [y/n]\r\nhttps://example.test/pi-link',
      }),
    )
    await waitFor(() =>
      expect(fixture.terminals[0]!.buffer.active.getLine(1)?.translateToString(true)).toContain(
        'https://example.test/pi-link',
      ),
    )
    const discover = () => {
      captureHostHintAdapters(ui.container)
      return discoverHostHintTargets(ui.container).filter(
        (target) => target.label === 'https://example.test/pi-link',
      )
    }
    if (provider === 'pi') {
      await waitFor(() => expect(discover()).toHaveLength(1))
      const target = discover()[0]!
      expect(activateHostHint(target)).toBe(true)
      expect(fixture.openExternal).toHaveBeenCalledWith('https://example.test/pi-link')
      act(() => receivePtyData({ id: 'hint-terminal', data: ' queued' }))
      expect(activateHostHint(target)).toBe(false)
      await waitFor(() => expect(discover()).toHaveLength(1))
      const next = discover()[0]!
      act(() => {
        store.set(agentTerminalsAtom, [])
        store.set(agentTerminalsAtom, [
          { id: 'hint-terminal', launchedFor: 'hint-session', title: '' },
        ])
      })
      expect(activateHostHint(next)).toBe(false)
    } else {
      expect(discover()).toHaveLength(0)
      expect(fixture.openExternal).not.toHaveBeenCalled()
    }
    expect(
      discoverHostHintTargets(ui.container).some((target) => target.label.includes('Approve tool')),
    ).toBe(false)
  },
)
