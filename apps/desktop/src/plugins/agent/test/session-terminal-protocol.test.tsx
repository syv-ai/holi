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
      <SessionTerminal terminalId="protocol-terminal" visible={visible} />
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
