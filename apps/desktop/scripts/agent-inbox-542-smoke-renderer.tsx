import { createStore, Provider, useAtomValue, useSetAtom } from 'jotai'
import '../src/renderer/src/index.css'
import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { TooltipProvider } from '../src/renderer/src/components/ui/tooltip'
import { Toaster } from '../src/renderer/src/components/ui/sonner'
import { Button } from '../src/renderer/src/components/ui/button'
import { InboxEntries } from '../src/plugins/agent/renderer/agents/inbox-entries'
import { AgentSurface } from '../src/plugins/agent/renderer/agent-surface'
import { agentRenderer } from '../src/plugins/agent/renderer'
import { installFakeHoli } from '../src/renderer/src/test/fake-holi'
import { emptyVaultSnapshot } from '@holi/shared'
import { subscribeToVault } from '../src/renderer/src/state/vaults'
import {
  activeRemoteAtom,
  activeSurfaceIdAtom,
  closeSurfaceTabAtom,
  snapshotAtom,
  appModeAtom,
  agentsSelectionAtom,
  openSurfaceAtom,
  surfaceTabIdsAtom,
  vaultsAtom,
} from '../src/renderer/src/plugin-api'
import { openSessionAtom } from '../src/plugins/agent/renderer/state/send'
import { agentSessionsAtom, agentTerminalsAtom } from '../src/plugins/agent/renderer/state/sessions'
import { agentsViewAtom } from '../src/plugins/agent/renderer/state/agents-view'
import { inboxAtom } from '../src/plugins/agent/renderer/state/inbox'

window.addEventListener('error', (event) =>
  console.error('SMOKE_ERROR_STACK', event.error?.stack ?? event.message),
)
window.addEventListener('unhandledrejection', (event) =>
  console.error('SMOKE_REJECTION_STACK', event.reason?.stack ?? event.reason),
)
const remote = 'smoke/542-vault'
const store = createStore()
let ptyEvents = 0
let inboxView: { entries: unknown[]; unread: number } = { entries: [], unread: 0 }
const fake = installFakeHoli(async (op) => {
  if (op.path === 'vaults.open') return emptyVaultSnapshot()
  if (op.path === 'cap.names') return []
  if (op.path === 'cap.run') {
    const input = op.input as { name: string }
    if (input.name === 'agent.attach') return ''
    if (input.name === 'agent.open') return { ok: false, message: 'Session is unavailable' }
    if (input.name === 'agent.turns') return []
    if (input.name === 'agent.inbox') return inboxView
    if (input.name === 'agent.inboxSeen' || input.name === 'agent.inboxDismiss') return inboxView
    if (
      input.name === 'agent.sessions' ||
      input.name === 'agent.history' ||
      input.name === 'agent.terminals'
    )
      return []
    if (input.name === 'agent.open') return { terminalId: 'smoke-terminal' }
    return { ok: true }
  }
  return undefined
})
store.set(activeRemoteAtom, remote)
store.set(snapshotAtom, emptyVaultSnapshot())
store.set(vaultsAtom, [{ remote, name: '542 smoke vault', path: '/tmp/holi-542-vault' }] as never)
store.set(agentSessionsAtom, [
  { id: 'p0123456789ab', provider: 'pi', name: 'Pi smoke session', state: 'running' },
  { id: 'p0123456789ac', provider: 'codex', name: 'Codex smoke session', state: 'running' },
  { id: 'a1b2c3d4', provider: 'claude', name: 'Claude smoke session', state: 'running' },
] as never)
store.set(agentTerminalsAtom, [
  { id: 'terminal-pi-542', launchedFor: 'p0123456789ab', title: 'Pi smoke terminal' },
  { id: 'terminal-codex-542', launchedFor: 'p0123456789ac', title: 'Codex smoke terminal' },
  { id: 'terminal-claude-542', launchedFor: 'a1b2c3d4', title: 'Claude smoke terminal' },
] as never)

const unsubscribe = subscribeToVault(store, [agentRenderer])
store.set(appModeAtom, 'agents')
store.set(agentsSelectionAtom, { owner: 'agent', id: 'home' })
store.set(openSurfaceAtom, 'agent', 'terminal-pi-542')

const bridge = (
  window as unknown as {
    agent542: {
      onCommand: (cb: (command: unknown) => void) => void
      onInbox: (cb: (payload: unknown) => void) => void
    }
  }
).agent542
const smoke = ((
  window as unknown as { smoke542: Record<string, (...args: never[]) => unknown> }
).smoke542 = {
  pushInbox: (payload: unknown) => {
    inboxView = payload as typeof inboxView
    fake.pushPluginEvent('agent', { remote, name: 'inbox', payload })
  },
  pushOpen: (payload: unknown) =>
    fake.pushNavigate({ remote, plugin: 'agent', name: 'inbox-open', payload } as never),
  pushDeath: () => fake.pushPluginEvent('agent', { remote, name: 'terminals', payload: [] }),
  openUnavailable: () =>
    fake.pushPluginEvent('agent', {
      remote,
      name: 'inbox-open',
      payload: {
        id: 'unavailable-542',
        at: new Date().toISOString(),
        title: 'Unavailable fixture',
        line: 'Synthetic missing session',
        session: 'deadbeef',
      },
    }),
  setVault: (value: string) => store.set(activeRemoteAtom, value),
  showTerminal: (id: string) => store.set(openSurfaceAtom, 'agent', id),
  calls: () => fake.calls,
  sessions: () => store.get(agentSessionsAtom),
  terminals: () => store.get(agentTerminalsAtom),
  inbox: () => store.get(inboxAtom),
  closePiTab: () => store.set(closeSurfaceTabAtom, 'agent', 'terminal-pi-542'),
  reopenPi: () => store.set(openSessionAtom, 'p0123456789ab'),
  activeId: () => store.get(agentsViewAtom),
})
let navigationCount = 0
const api = window as unknown as {
  agent542: {
    request: (action: string, payload?: string) => Promise<unknown>
  }
}
Object.assign(smoke, {
  pushPty: (id: string, data: string) => {
    ptyEvents++
    fake.pushPluginEvent('agent', { remote, name: 'pty-data', payload: { id, data } })
  },
  setTheme: (theme: string) => document.documentElement.setAttribute('data-theme', theme),
  capture: (name: string) => api.agent542.request('capture', name),
  clickBanner: (title: string) => api.agent542.request('banner-callback', title),
  pushOpen: smoke.pushOpen,
  pushDeath: smoke.pushDeath,
  setVault: smoke.setVault,
  openCalls: () =>
    fake.calls.filter((call) => JSON.stringify(call.input).includes('agent.open')).length,
  reopen: smoke.reopenPi,
  navigationCount: () => navigationCount,
  state: () => ({
    active: smoke.activeId(),
    ptyEvents,
    terminals: smoke.terminals(),
    sessions: smoke.sessions(),
    inbox: smoke.inbox(),
    calls: fake.calls,
  }),
  openFirstInboxEntry: () => {
    const button = [...document.querySelectorAll('button')].find((node) =>
      node.textContent?.includes('Review the 542 smoke deliverable'),
    )
    if (!button) throw new Error('Inbox entry button was not rendered')
    button.click()
  },
})
bridge?.onInbox?.((payload) => {
  inboxView = payload as typeof inboxView
  fake.pushPluginEvent('agent', { remote, name: 'inbox', payload })
})
bridge?.onCommand?.((command) => {
  navigationCount++
  const req = command as { remote: string; plugin: string; name: string; payload: unknown }
  fake.pushPluginEvent('agent', { remote: req.remote, name: req.name, payload: req.payload })
})

function Demo() {
  const terminals = useAtomValue(agentTerminalsAtom)
  const active = useAtomValue(activeSurfaceIdAtom('agent'))
  const open = useSetAtom(openSessionAtom)
  useEffect(() => {
    const style = document.createElement('style')
    style.textContent =
      'html,body,#root{height:100%;margin:0}body{font-family:Geist,system-ui,sans-serif;background:var(--background);color:var(--foreground)}'
    document.head.append(style)
    return () => style.remove()
  }, [])
  return (
    <main className="grid h-full grid-cols-[320px_1fr] gap-4 bg-background p-5 text-foreground">
      <aside className="flex min-h-0 flex-col gap-4 border-r border-divider pr-4">
        <header className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold">Agents</h1>
          <p className="text-sm text-muted-foreground">542 native smoke · isolated vault</p>
        </header>
        <section aria-label="Production Inbox">
          <InboxEntries />
        </section>
        <section aria-label="Smoke session controls" className="flex flex-col gap-2 text-sm">
          <h2 className="font-medium">Sessions</h2>
          {['p0123456789ab', 'p0123456789ac', 'a1b2c3d4'].map((id) => (
            <Button key={id} type="button" variant="ghost" size="row" onClick={() => void open(id)}>
              {id}
            </Button>
          ))}
          <output>{terminals.map((t) => t.id).join(', ')}</output>
        </section>
      </aside>
      <section
        aria-label="Production agent terminal"
        className="min-h-0 overflow-hidden bg-background"
      >
        {terminals.map((t) => (
          <div key={t.id} hidden={active !== t.id} className="h-full">
            <AgentSurface id={t.id} visible={active === t.id} />
          </div>
        ))}
        {!terminals.length && <p>No open agent terminal</p>}
      </section>
    </main>
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
