import { act, cleanup } from '@testing-library/react'
import { createStore, Provider } from 'jotai'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { render } from '@/test/render'
import { activeRemoteAtom, openTabAtom } from '@/plugin-api'
import { SessionTerminal } from '../renderer/session-terminal'
import { AgentsView } from '../renderer/agents/agents-view'
import { agentSessionsAtom, type AgentSession } from '../renderer/state/sessions'
import { viewTerminalsAtom } from '../renderer/state/agents-view'
import * as terminals from '../renderer/lib/session-terminals'
import { agentRenderer } from '../renderer/index'

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  open: vi.fn(),
  detach: vi.fn(),
  send: vi.fn(),
  history: vi.fn(),
  sessions: vi.fn(),
  terminals: vi.fn(),
  inbox: vi.fn(),
  providers: vi.fn(),
  theme: vi.fn(),
  stopTheme: vi.fn(),
  stopQueries: vi.fn(),
}))
vi.mock('../renderer/agent-cap', () => ({ agentCap: mocks }))
vi.mock('@/lib/terminal-theme', () => ({
  terminalTheme: () => ({ foreground: '#ffffff', background: '#000000' }),
  watchTerminalTheme: (_: unknown, callback: unknown) => {
    mocks.theme(callback)
    return mocks.stopTheme
  },
  suppressTerminalColorQueries: () => mocks.stopQueries,
}))

// Keep callbacks available after dispose deliberately: an already queued browser
// callback must be harmless even if cancellation lost the race.
const { XtermDouble, FitDouble } = vi.hoisted(() => {
  class XtermDouble {
    static instances: XtermDouble[] = []
    options: Record<string, unknown>
    cols = 80
    rows = 24
    buffer = { active: { viewportY: 17, getLine: () => undefined } }
    selection = ''
    mount!: HTMLElement
    textarea!: HTMLTextAreaElement
    data!: (data: string) => void
    key!: (event: KeyboardEvent) => boolean
    selected!: () => void
    parsed: Array<() => void> = []
    subscriptions: Array<ReturnType<typeof vi.fn>> = []
    dispose = vi.fn()
    write = vi.fn()
    focus = vi.fn(() => this.textarea.focus())
    scrollToTop = vi.fn()
    scrollToBottom = vi.fn()
    getSelection = () => this.selection
    constructor(options: Record<string, unknown>) {
      this.options = options
      XtermDouble.instances.push(this)
    }
    loadAddon(addon: { term?: XtermDouble }) {
      addon.term = this
    }
    open(mount: HTMLElement) {
      this.mount = mount
      this.textarea = document.createElement('textarea')
      mount.append(this.textarea)
    }
    subscribe() {
      const dispose = vi.fn()
      this.subscriptions.push(dispose)
      return { dispose }
    }
    onData(callback: (data: string) => void) {
      this.data = callback
      return this.subscribe()
    }
    onSelectionChange(callback: () => void) {
      this.selected = callback
      return this.subscribe()
    }
    onWriteParsed(callback: () => void) {
      this.parsed.push(callback)
      return this.subscribe()
    }
    attachCustomKeyEventHandler(callback: (event: KeyboardEvent) => boolean) {
      this.key = callback
    }
    registerLinkProvider() {
      return this.subscribe()
    }
    // The disabled textarea gates keyboard/paste; onData also carries automatic
    // device replies, which must keep flowing while hidden.
    nativeInput(text: string) {
      if (!this.textarea.disabled) this.data(text)
    }
  }
  class FitDouble {
    static instances: FitDouble[] = []
    term!: XtermDouble
    fit = vi.fn(() => {
      this.term.cols = Math.max(2, Math.floor(this.term.mount.clientWidth / 8))
      this.term.rows = Math.max(1, Math.floor(this.term.mount.clientHeight / 16))
    })
    constructor() {
      FitDouble.instances.push(this)
    }
  }
  return { XtermDouble, FitDouble }
})
vi.mock('@xterm/xterm', () => ({ Terminal: XtermDouble }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: FitDouble }))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}))

const REMOTE = 'fixture/first'
const ID = 'p0123456789abc'
const observers: Array<{ callback: () => void; disconnect: ReturnType<typeof vi.fn> }> = []
let frames: FrameRequestCallback[]
let fonts: ReturnType<typeof deferred<void>>
let width: number
let height: number
let readText: ReturnType<typeof vi.fn>
let writeText: ReturnType<typeof vi.fn>

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function key(code: string, extra: KeyboardEventInit = {}) {
  return new KeyboardEvent('keydown', { key: code, code, metaKey: true, ...extra })
}
async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}
function runFrames() {
  act(() => {
    for (let batch = frames.splice(0); batch.length; batch = frames.splice(0)) {
      batch.forEach((callback) => callback(0))
    }
  })
}
function fixture() {
  const store = createStore()
  store.set(activeRemoteAtom, REMOTE)
  store.set(openTabAtom, { kind: 'surface', surface: 'agent', id: ID })
  return store
}
function sent(name: string) {
  return mocks.send.mock.calls.filter(([, event]) => event.name === name).map(([, event]) => event)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.attach.mockResolvedValue('mirror')
  mocks.open.mockResolvedValue({ ok: true, terminalId: 'new-window' })
  mocks.detach.mockResolvedValue(undefined)
  mocks.history.mockResolvedValue([])
  mocks.sessions.mockResolvedValue([])
  mocks.terminals.mockResolvedValue([])
  mocks.inbox.mockResolvedValue({ entries: [], unread: 0 })
  mocks.providers.mockResolvedValue([])
  XtermDouble.instances = []
  FitDouble.instances = []
  observers.length = 0
  frames = []
  width = 800
  height = 400
  fonts = deferred<void>()
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      disconnect = vi.fn()
      constructor(callback: () => void) {
        observers.push({ callback, disconnect: this.disconnect })
      }
      observe() {}
    },
  )
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('holi', { plugin: { send: mocks.send } })
  Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: fonts.promise } })
  readText = vi.fn().mockResolvedValue('clipboard')
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { readText, writeText },
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(document, 'fonts')
  Reflect.deleteProperty(navigator, 'clipboard')
})

test.each(['claude', 'codex', 'pi'] as const)(
  '%s keeps one xterm, attachment, viewport and selection through hide/show',
  async (provider) => {
    const store = fixture()
    const view = (visible: boolean) => (
      <Provider store={store}>
        <SessionTerminal terminalId={ID} provider={provider} visible={visible} />
      </Provider>
    )
    const ui = render(view(true))
    await flush()
    runFrames()
    const term = XtermDouble.instances[0]!
    const fit = FitDouble.instances[0]!
    term.selection = 'selected output'
    term.selected()
    term.selection = '' // TUI redraw clears xterm's current selection, not our copy cache.
    ui.rerender(view(false))
    expect(term.textarea.disabled).toBe(true)
    term.focus.mockClear()
    const fits = fit.fit.mock.calls.length
    mocks.send.mockClear()
    act(() => {
      terminals.receivePtyData({ id: ID, data: 'background output' })
      terminals.focusSessionTerminal(ID)
      term.nativeInput('hidden input')
      expect(term.key(key('Enter', { shiftKey: true, metaKey: false }))).toBe(false)
      expect(term.key(key('KeyV'))).toBe(false)
      expect(term.key(key('KeyC'))).toBe(false)
      expect(term.key(key('ArrowUp'))).toBe(false)
      observers[0]!.callback() // Even a stale nonzero report must not fit a hidden host.
    })
    expect(term.write).toHaveBeenCalledWith('background output')
    expect(term.focus).not.toHaveBeenCalled()
    expect(readText).not.toHaveBeenCalled()
    expect(writeText).not.toHaveBeenCalled()
    expect(term.scrollToTop).not.toHaveBeenCalled()
    expect(sent('pty-write')).toEqual([])
    expect(fit.fit).toHaveBeenCalledTimes(fits)
    width = height = 0
    act(() => observers[0]!.callback())
    expect(sent('pty-resize')).toEqual([])
    width = 960
    height = 480
    ui.rerender(view(true))
    runFrames()
    expect(XtermDouble.instances).toEqual([term])
    expect(mocks.attach).toHaveBeenCalledExactlyOnceWith(REMOTE, { id: ID })
    expect(term.buffer.active.viewportY).toBe(17)
    term.key(key('KeyC'))
    expect(writeText).toHaveBeenCalledWith('selected output')
    expect(term.textarea.disabled).toBe(false)
    term.nativeInput('visible input')
    expect(sent('pty-write').at(-1)).toMatchObject({
      remote: REMOTE,
      payload: { id: ID, data: 'visible input' },
    })
    expect(sent('pty-resize').at(-1)).toMatchObject({ payload: { cols: 120, rows: 30 } })
  },
)

test('hidden terminals still answer automatic xterm device queries', async () => {
  const store = fixture()
  const view = (visible: boolean) => (
    <Provider store={store}>
      <SessionTerminal terminalId={ID} visible={visible} />
    </Provider>
  )
  const ui = render(view(true))
  await flush()
  ui.rerender(view(false))
  mocks.send.mockClear()
  const term = XtermDouble.instances[0]!
  term.nativeInput('blocked user input')
  term.data('\x1b[12;34R')
  expect(sent('pty-write')).toEqual([
    { remote: REMOTE, name: 'pty-write', payload: { id: ID, data: '\x1b[12;34R' } },
  ])
})

test.each(['close', 'vault departure'] as const)(
  'pending paste and browser callbacks cannot outlive %s',
  async (departure) => {
    const store = fixture()
    const attach = deferred<string>()
    const paste = deferred<string>()
    mocks.attach.mockReturnValueOnce(attach.promise)
    readText.mockReturnValueOnce(paste.promise)
    const view = (visible: boolean) => (
      <Provider store={store}>
        <SessionTerminal terminalId={ID} visible={visible} />
      </Provider>
    )
    const register = vi.spyOn(terminals, 'registerSessionTerminal')
    const ui = render(view(true))
    const old = XtermDouble.instances[0]!
    const oldHandle = register.mock.calls[0]![1]
    const oldTheme = mocks.theme.mock.calls[0]![0] as (theme: object) => void
    const oldFit = FitDouble.instances[0]!
    act(() => frames.shift()?.(0)) // Leave the second layout frame queued at teardown.
    old.key(key('KeyV'))
    if (departure === 'close') ui.unmount()
    else {
      ui.rerender(view(false))
      act(() => store.set(activeRemoteAtom, 'fixture/second'))
      ui.rerender(view(true)) // Same id, another vault, visible again before clipboard resolves.
      await flush()
      runFrames() // The replacement's valid first layout is not an old callback.
    }
    oldFit.fit.mockClear()
    old.write.mockClear()
    old.focus.mockClear()
    mocks.send.mockClear()
    await act(async () => {
      paste.resolve('old clipboard')
      attach.resolve('old replay')
      fonts.resolve()
      await Promise.resolve()
    })
    runFrames()
    act(() => {
      observers[0]!.callback()
      old.parsed.forEach((callback) => callback())
      oldHandle.focus()
      oldHandle.write('stale cached handle')
      oldTheme({ foreground: '#ffffff' })
      old.data('old callback input')
      old.key(key('Enter', { shiftKey: true, metaKey: false }))
      vi.runAllTimers()
    })
    expect(sent('pty-write')).toEqual([])
    expect(sent('pty-resize')).toEqual([])
    expect(sent('pty-appearance')).toEqual([])
    expect(oldFit.fit).not.toHaveBeenCalled()
    expect(old.write).not.toHaveBeenCalled()
    expect(old.focus).not.toHaveBeenCalled()
    expect(old.dispose).toHaveBeenCalledTimes(1)
    expect(observers[0]!.disconnect).toHaveBeenCalledTimes(1)
    old.subscriptions.slice(0, 3).forEach((dispose) => expect(dispose).toHaveBeenCalledTimes(1))
    expect(mocks.stopTheme).toHaveBeenCalledTimes(1)
    expect(mocks.stopQueries).toHaveBeenCalledTimes(1)
    // Close the replacement too, then the shared cache must have no handle.
    ui.unmount()
    expect(terminals.focusSessionTerminal(ID)).toBe(false)
    old.write.mockClear()
    terminals.receivePtyData({ id: ID, data: 'after close' })
    expect(old.write).not.toHaveBeenCalled()
    expect(old.dispose).toHaveBeenCalledTimes(1)
    register.mockRestore()
  },
)

test('first show focuses the active terminal, not an unfocused split or a foreground control', async () => {
  const store = fixture()
  const view = (visible: boolean) => (
    <Provider store={store}>
      <SessionTerminal terminalId={ID} visible={visible} />
    </Provider>
  )
  const ui = render(view(true))
  await flush()
  runFrames()
  const term = XtermDouble.instances[0]!
  expect(term.focus).toHaveBeenCalledTimes(1)
  ui.rerender(view(false))
  act(() => store.set(openTabAtom, { kind: 'surface', surface: 'agent', id: 'other' }))
  term.focus.mockClear()
  ui.rerender(view(true))
  runFrames()
  expect(term.focus).not.toHaveBeenCalled()
  ui.rerender(view(false))
  act(() => store.set(openTabAtom, { kind: 'surface', surface: 'agent', id: ID }))
  const control = document.createElement('input')
  document.body.append(control)
  ui.rerender(view(true))
  control.focus() // A deliberate focus change after show must win the pending handoff.
  runFrames()
  expect(document.activeElement).toBe(control)
  expect(term.focus).not.toHaveBeenCalled()
  control.remove()
})

test.each(['tab trigger', 'New session button'])(
  'first show hands focus from its initiating %s to xterm',
  async (initiator) => {
    const control = document.createElement('button')
    control.textContent = initiator
    if (initiator === 'tab trigger') control.setAttribute('role', 'tab')
    document.body.append(control)
    control.focus()
    try {
      const store = fixture()
      render(
        <Provider store={store}>
          <SessionTerminal terminalId={ID} visible />
        </Provider>,
      )
      await flush()
      runFrames()
      const term = XtermDouble.instances[0]!
      expect(term.focus).toHaveBeenCalledTimes(1)
      expect(document.activeElement).toBe(term.textarea)
    } finally {
      control.remove()
    }
  },
)

test('native tab focus after mouse-down selection completes the pending handoff', async () => {
  const header = document.createElement('div')
  header.dataset.slot = 'site-header'
  const trigger = document.createElement('button')
  trigger.setAttribute('role', 'tab')
  trigger.setAttribute('aria-selected', 'true')
  header.append(trigger)
  document.body.append(header)
  try {
    const store = fixture()
    render(
      <Provider store={store}>
        <SessionTerminal terminalId={ID} visible />
      </Provider>,
    )
    // Radix updates the workspace in mouse-down; the browser's default focus
    // follows, after React has already committed the visible terminal.
    trigger.focus()
    await flush()
    runFrames()
    expect(document.activeElement).toBe(XtermDouble.instances[0]!.textarea)
  } finally {
    header.remove()
  }
})

function session(provider: AgentSession['provider'], id = ID): AgentSession {
  return { id, provider, name: 'Fixture session', state: 'idle' }
}

test.each(['claude', 'codex', 'pi'] as const)(
  'real AgentsView propagates %s visibility and detaches only on close',
  async (provider) => {
    const store = fixture()
    store.set(agentSessionsAtom, [session(provider)])
    store.set(viewTerminalsAtom, { [ID]: ID })
    store.set(openTabAtom, { kind: 'session', owner: 'agent', id: `session:${ID}` })
    const view = (visible: boolean) => (
      <Provider store={store}>
        <AgentsView selection={{ owner: 'agent', id: `session:${ID}` }} visible={visible} />
      </Provider>
    )
    const ui = render(view(true))
    await flush()
    const term = XtermDouble.instances[0]!
    runFrames()
    expect(term.focus).toHaveBeenCalledTimes(1)
    ui.rerender(view(false))
    expect(term.textarea.disabled).toBe(true)
    ui.rerender(view(true))
    expect(term.textarea.disabled).toBe(false)
    expect(XtermDouble.instances).toEqual([term])
    expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.attach).toHaveBeenCalledExactlyOnceWith(REMOTE, { id: ID })
    expect(mocks.detach).not.toHaveBeenCalled()
    ui.unmount()
    expect(mocks.detach).toHaveBeenCalledExactlyOnceWith(REMOTE, { id: ID })
    expect(store.get(viewTerminalsAtom)).toEqual({})
    expect(term.dispose).toHaveBeenCalledTimes(1)
    expect(terminals.focusSessionTerminal(ID)).toBe(false)
  },
)

test.each(['missing', 'closed'] as const)(
  'AgentsView removes the old terminal when its session is %s',
  async (state) => {
    const store = fixture()
    store.set(agentSessionsAtom, [session('codex')])
    store.set(viewTerminalsAtom, { [ID]: ID })
    render(
      <Provider store={store}>
        <AgentsView selection={{ owner: 'agent', id: `session:${ID}` }} />
      </Provider>,
    )
    await flush()
    const term = XtermDouble.instances[0]!
    act(() =>
      store.set(
        agentSessionsAtom,
        state === 'missing' ? [] : [{ ...session('codex'), closed: true }],
      ),
    )
    expect(term.dispose).toHaveBeenCalledTimes(1)
    expect(mocks.detach).toHaveBeenCalledExactlyOnceWith(REMOTE, { id: ID })
    expect(terminals.focusSessionTerminal(ID)).toBe(false)
  },
)

test('Pi RPC views do not build terminals and are not retained by the terminal policy', async () => {
  const store = fixture()
  const leave = agentRenderer.vault!(REMOTE, store)
  await flush()
  store.set(agentSessionsAtom, [session('pi', '1234abcd'), session('claude', 'abcd1234')])
  const selection = { owner: 'agent', id: 'session:1234abcd' }
  render(
    <Provider store={store}>
      <AgentsView selection={selection} />
    </Provider>,
  )
  expect(XtermDouble.instances).toEqual([])
  expect(mocks.attach).not.toHaveBeenCalled()
  expect(mocks.open).not.toHaveBeenCalled()
  const policy = agentRenderer.agentsMode!.keepsSelectionMounted!
  expect(policy(selection)).toBe(false)
  expect(policy({ owner: 'agent', id: `session:${ID}` })).toBe(true)
  expect(policy({ owner: 'agent', id: 'history' })).toBe(false)
  expect(policy({ owner: 'other', id: `session:${ID}` })).toBe(false)
  // An eight-character Claude id is still a native terminal.
  expect(policy({ owner: 'agent', id: 'session:abcd1234' })).toBe(true)
  act(leave)
})

test('reopening a closed session waits for its new window instead of reattaching the disposed terminal', async () => {
  const store = fixture()
  store.set(agentSessionsAtom, [session('claude')])
  store.set(viewTerminalsAtom, { [ID]: ID })
  render(
    <Provider store={store}>
      <AgentsView selection={{ owner: 'agent', id: `session:${ID}` }} />
    </Provider>,
  )
  await flush()
  act(() => store.set(agentSessionsAtom, [{ ...session('claude'), closed: true }]))
  const reopened = deferred<{ ok: true; terminalId: string }>()
  mocks.open.mockReturnValueOnce(reopened.promise)
  act(() => store.set(agentSessionsAtom, [session('claude')]))
  expect(XtermDouble.instances).toHaveLength(1)
  expect(mocks.attach).toHaveBeenCalledTimes(1)
  await act(async () => reopened.resolve({ ok: true, terminalId: 'replacement' }))
  expect(XtermDouble.instances).toHaveLength(2)
  expect(mocks.attach).toHaveBeenLastCalledWith(REMOTE, { id: 'replacement' })
})

test('a never-shown terminal defers construction and attach until its first show', async () => {
  const store = fixture()
  const view = (visible: boolean) => (
    <Provider store={store}>
      <SessionTerminal terminalId={ID} visible={visible} />
    </Provider>
  )
  const ui = render(view(false))
  runFrames()
  expect(XtermDouble.instances).toEqual([])
  expect(mocks.attach).not.toHaveBeenCalled()
  ui.rerender(view(true))
  await flush()
  expect(XtermDouble.instances).toHaveLength(1)
  expect(mocks.attach).toHaveBeenCalledExactlyOnceWith(REMOTE, { id: ID })
})

test('AgentsView does not reuse the previous vault window while its new window is opening', async () => {
  const store = fixture()
  store.set(agentSessionsAtom, [session('codex')])
  store.set(viewTerminalsAtom, { [ID]: ID })
  const ui = render(
    <Provider store={store}>
      <AgentsView selection={{ owner: 'agent', id: `session:${ID}` }} />
    </Provider>,
  )
  await flush()
  const opened = deferred<{ ok: true; terminalId: string }>()
  mocks.open.mockReturnValueOnce(opened.promise)
  act(() => store.set(activeRemoteAtom, 'fixture/second'))
  expect(mocks.attach).toHaveBeenCalledTimes(1)
  expect(XtermDouble.instances).toHaveLength(1)
  expect(XtermDouble.instances[0]!.dispose).toHaveBeenCalledTimes(1)
  await act(async () => opened.resolve({ ok: true, terminalId: 'second-vault-window' }))
  expect(mocks.attach).toHaveBeenLastCalledWith('fixture/second', { id: 'second-vault-window' })
  ui.unmount()
  expect(mocks.detach.mock.calls).toEqual([
    [REMOTE, { id: ID }],
    ['fixture/second', { id: 'second-vault-window' }],
  ])
})
