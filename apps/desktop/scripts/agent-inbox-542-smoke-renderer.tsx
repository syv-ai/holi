import { createStore, Provider, useAtomValue } from 'jotai'
import '../src/renderer/src/index.css'
import { createRoot } from 'react-dom/client'
import { TooltipProvider } from '../src/renderer/src/components/ui/tooltip'
import { Toaster } from '../src/renderer/src/components/ui/sonner'
import { InboxEntries } from '../src/plugins/agent/renderer/agents/inbox-entries'
import { AgentsView } from '../src/plugins/agent/renderer/agents/agents-view'
import { agentRenderer } from '../src/plugins/agent/renderer'
import { installFakeHoli } from '../src/renderer/src/test/fake-holi'
import { openVaultAtom, openedRemoteAtom, subscribeToVault } from '../src/renderer/src/state/vaults'
import { hostPluginVaults, installedPluginsAtom } from '../src/renderer/src/state/plugins'
import { shellWorkspaceAtom } from '../src/renderer/src/state/shell-tabs'
import { allTabs, closeTab, focusedTab } from '../src/renderer/src/state/shell-workspace'
import { parseTabKey } from '../src/renderer/src/state/tab-descriptor'
import { useSessionTabs } from '../src/renderer/src/hooks/use-session-tabs'
import { useRetainedSurfaces } from '../src/renderer/src/features/shell/retained-surfaces'
import {
  activeRemoteAtom,
  activeSurfaceIdAtom,
  appModeAtom,
  snapshotAtom,
  vaultsAtom,
} from '../src/renderer/src/plugin-api'
import { agentSessionsAtom, agentTerminalsAtom } from '../src/plugins/agent/renderer/state/sessions'
import { agentsViewAtom, viewTerminalsAtom } from '../src/plugins/agent/renderer/state/agents-view'
import { inboxAtom } from '../src/plugins/agent/renderer/state/inbox'
import type { FakeHoli } from '../src/renderer/src/test/fake-holi'

type Navigation = Parameters<FakeHoli['pushNavigate']>[0]
type PluginEvent = Parameters<FakeHoli['pushPluginEvent']>[1]
const bridge = (
  window as unknown as {
    agent542: {
      request(action: string, payload?: unknown): Promise<unknown>
      onCommand(cb: (request: Navigation) => void): () => void
      onEvent(cb: (event: PluginEvent) => void): () => void
    }
  }
).agent542
const store = createStore()
const fake = installFakeHoli((op) => bridge.request('trpc', op))
store.set(installedPluginsAtom, [agentRenderer])
const offEvents = subscribeToVault(store, [agentRenderer])
const offVaults = hostPluginVaults(store)
let navigationCount = 0
const offCommand = bridge.onCommand((request) => {
  navigationCount++
  // The actual application subscription owns switching vaults and dispatching
  // inbox-open. Do not shortcut it with a plugin event.
  fake.pushNavigate(request)
})
const offEvent = bridge.onEvent((event) => fake.pushPluginEvent('agent', event))
window.addEventListener('error', (event) => console.error(event.error?.stack ?? event.message))
window.addEventListener('unhandledrejection', (event) => console.error(event.reason))

const api = {
  async initialize() {
    store.set(vaultsAtom, (await bridge.request('vaults')) as never)
    await store.set(openVaultAtom, 'smoke/542-vault')
    store.set(appModeAtom, 'agents')
  },
  switchVault: (remote: string) => store.set(openVaultAtom, remote),
  closeSession: (id: string) => {
    const workspace = store.get(shellWorkspaceAtom)
    const key = allTabs(workspace).find((key) => {
      const tab = parseTabKey(key)
      return tab?.kind === 'session' && tab.id === `session:${id}`
    })
    if (!key) throw new Error(`No canonical session tab for ${id}`)
    store.set(shellWorkspaceAtom, closeTab(workspace, key))
  },
  state: () => ({
    remote: store.get(activeRemoteAtom),
    openedRemote: store.get(openedRemoteAtom),
    snapshot: store.get(snapshotAtom),
    active: store.get(agentsViewAtom),
    activeSurface: store.get(activeSurfaceIdAtom('agent')),
    workspace: store.get(shellWorkspaceAtom),
    tabs: allTabs(store.get(shellWorkspaceAtom)).map(parseTabKey),
    terminals: store.get(agentTerminalsAtom),
    sessions: store.get(agentSessionsAtom),
    viewTerminals: store.get(viewTerminalsAtom),
    inbox: store.get(inboxAtom),
    calls: fake.calls,
    sent: fake.pluginSent,
    navigationCount,
  }),
  dispose: () => {
    offCommand()
    offEvent()
    offVaults()
    offEvents()
    fake.restore()
  },
}
;(window as unknown as { smoke542: typeof api }).smoke542 = api

// Only the frame is a fixture. Rows, canonical session selections, lifecycle,
// and session/xterm views below are production modules. No invented UI states.
function Demo() {
  const remote = useAtomValue(activeRemoteAtom)
  const workspace = useAtomValue(shellWorkspaceAtom)
  const sessions = useAtomValue(agentSessionsAtom)
  const selected = focusedTab(workspace)
  useSessionTabs(selected)
  const retained = useRetainedSurfaces(
    selected === null ? [] : [selected],
    (key, visible) => {
      const tab = parseTabKey(key)
      if (tab?.kind !== 'session') return null
      const id = tab.id.replace(/^session:/, '')
      const session = sessions.find((session) => session.id === id)
      return (
        <div
          hidden={!visible}
          data-session={id}
          data-provider={session?.provider}
          className="flex min-h-0 flex-1 flex-col"
        >
          <AgentsView selection={{ owner: tab.owner, id: tab.id }} visible={visible} />
        </div>
      )
    },
    (key) => {
      const tab = parseTabKey(key)
      return (
        tab?.kind === 'session' &&
        (agentRenderer.agentsMode?.keepsSelectionMounted?.({ owner: tab.owner, id: tab.id }) ??
          false)
      )
    },
  )
  return (
    <>
      {retained.content}
      <main className="grid h-full grid-cols-[360px_1fr] gap-4 bg-background p-5 text-foreground">
        <aside className="flex min-h-0 flex-col gap-4 overflow-auto border-r border-divider pr-4">
          <header className="flex flex-col gap-1">
            <h1 className="text-lg font-semibold tracking-tight">Agents</h1>
            <p className="text-sm text-muted-foreground">{remote} · isolated native smoke</p>
          </header>
          <section aria-label="Production Inbox">
            <InboxEntries />
          </section>
        </aside>
        <section aria-label="Production session views" className="flex min-h-0 flex-col">
          {selected !== null && retained.slot(selected)}
        </section>
      </main>
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <Provider store={store}>
    <TooltipProvider>
      <Demo />
      <Toaster />
    </TooltipProvider>
  </Provider>,
)
void api.initialize()
