import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import { HostHintLayer } from '../src/renderer/src/features/shell/host-hint-layer'
import { useShortcutDispatcher } from '../src/renderer/src/hooks/use-shortcuts'
import { Button } from '../src/renderer/src/components/ui/button'
import { TooltipProvider } from '../src/renderer/src/components/ui/tooltip'
import { activeRemoteAtom } from '../src/renderer/src/state/vaults'
import { sessionAtom } from '../src/renderer/src/state/session'
import { vimCodeEditingAtom } from '../src/renderer/src/state/preferences'
import { AgentSurface } from '../src/plugins/agent/renderer/agent-surface'
import { AgentsView } from '../src/plugins/agent/renderer/agents/agents-view'
import {
  agentEvents,
  agentSessionsAtom,
  agentTerminalsAtom,
} from '../src/plugins/agent/renderer/state/sessions'
import '../src/renderer/src/index.css'

const store = createStore()
const remote = 'native-fixture/pi-links'
const id = 'native-pi-hint-session'
const terminalId = 'native-pi-hint-terminal'
const owned = { id, name: 'Native Pi', provider: 'pi' as const, state: 'idle' as const }
store.set(sessionAtom, { login: 'isolated-native-fixture' })
store.set(activeRemoteAtom, remote)
store.set(vimCodeEditingAtom, true)
store.set(agentSessionsAtom, [owned])
store.set(agentTerminalsAtom, [{ id: terminalId, launchedFor: id, title: 'Native Pi' }])

type Controls = {
  path?: 'surface' | 'agents'
  visible?: boolean
  provider?: 'pi' | 'claude'
  owner?: string | null
  account?: string
  remote?: string
  vim?: boolean
  theme?: 'light' | 'dark'
}
function Fixture() {
  const [path, setPath] = useState<'surface' | 'agents'>('surface')
  const [visible, setVisible] = useState(true)
  useShortcutDispatcher()
  useEffect(
    () =>
      window.holi.plugin.on('agent', (raw) => {
        const event = raw as { name: string; remote: string; payload: unknown }
        agentEvents[event.name]?.(event, store)
      }),
    [],
  )
  ;(window as unknown as { piHintFixture: (value: Controls) => void }).piHintFixture = (value) => {
    if (value.path !== undefined) setPath(value.path)
    if (value.visible !== undefined) setVisible(value.visible)
    if (value.provider !== undefined)
      store.set(agentSessionsAtom, [{ ...owned, provider: value.provider }])
    if (value.owner !== undefined)
      store.set(agentTerminalsAtom, [
        { id: terminalId, launchedFor: value.owner ?? undefined, title: 'Native Pi' },
      ])
    if (value.account !== undefined) store.set(sessionAtom, { login: value.account })
    if (value.remote !== undefined) store.set(activeRemoteAtom, value.remote)
    if (value.vim !== undefined) store.set(vimCodeEditingAtom, value.vim)
    if (value.theme !== undefined) document.documentElement.dataset.theme = value.theme
  }
  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col" data-pane="primary" data-pane-focused="true">
        <div className="flex shrink-0 items-center gap-2 px-4 py-2">
          <Button id="host-focus" variant="quiet">
            Native Pi link acceptance
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col" hidden={!visible}>
          {path === 'surface' ? (
            <AgentSurface id={terminalId} visible={visible} />
          ) : (
            <AgentsView selection={{ owner: 'agent', id: `session:${id}` }} visible={visible} />
          )}
        </div>
        <HostHintLayer scopeKey="native-pi-links" />
      </div>
    </TooltipProvider>
  )
}
createRoot(document.getElementById('root')!).render(
  <Provider store={store}>
    <Fixture />
  </Provider>,
)
