/**
 * A tab of the Agents mode with nothing selected shows the agent's home,
 * even in a vault whose `plugins.yaml` an older Holi wrote with `agent:
 * false` and `chat: false`: the agent is built in and chat is retired, so a
 * stale pin turns nothing off. The Inbox is its own row, never the home.
 */
import { render, screen } from '@/test/render'
import { Provider, createStore, type WritableAtom } from 'jotai'
import { expect, test, vi } from 'vitest'
import {
  VAULT_SETTING_DEFAULTS,
  resolvePluginSettings,
  type ResolvedVaultSettings,
} from '@holi/shared'
import { activeRemoteAtom, type RendererPlugin } from '@/plugin-api'
import { AGENT_INFO } from '../info'
import { AgentsView } from '../renderer/agents/agents-view'

vi.mock('../renderer/agent-cap', () => ({
  agentCap: {
    providers: async () => [
      { id: 'claude', label: 'Claude Code', installed: true, background: true },
      { id: 'codex', label: 'Codex', installed: false, background: false },
    ],
  },
}))

// Core's plugin list and settings cache, reached as modules (a dynamic
// import: a plugin's code imports core only through @/plugin-api).
type Settable<T> = WritableAtom<T, [T], void>
const plugins = (await import('@/state/plugins')) as unknown as {
  installedPluginsAtom: Settable<readonly RendererPlugin[]>
}
const settings = (await import('@/state/settings')) as unknown as {
  vaultSettingsAtom: Settable<{ remote: string; settings: ResolvedVaultSettings } | null>
}

function vaultPinning(text: string, over: Partial<ResolvedVaultSettings> = {}) {
  const store = createStore()
  store.set(plugins.installedPluginsAtom, [{ info: AGENT_INFO }])
  store.set(activeRemoteAtom, 'o/r')
  const resolved = resolvePluginSettings(text, null, [AGENT_INFO])
  store.set(settings.vaultSettingsAtom, {
    remote: 'o/r',
    settings: {
      ...VAULT_SETTING_DEFAULTS,
      plugins: resolved.plugins,
      pluginValues: resolved.values,
      warnings: resolved.warnings,
      ...over,
    } as ResolvedVaultSettings,
  })
  return store
}

test('a vault with chat: false pinned still opens on the agent\'s home', () => {
  const store = vaultPinning('plugins:\n  chat: false\n  agent: false\n')
  render(
    <Provider store={store}>
      <AgentsView selection={null} />
    </Provider>,
  )
  expect(screen.getByText('No session here')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'New session' })).toBeInTheDocument()
  expect(screen.queryByText('Nothing needs you')).not.toBeInTheDocument()
})

test("the home names this machine's agent", () => {
  const store = vaultPinning('plugins: {}\n', { agentProvider: 'codex' })
  render(
    <Provider store={store}>
      <AgentsView selection={null} />
    </Provider>,
  )
  expect(screen.getByText(/in Codex\./)).toBeInTheDocument()
})

test('the Inbox is its own view, not the home', () => {
  const store = vaultPinning('plugins: {}\n')
  render(
    <Provider store={store}>
      <AgentsView selection={{ owner: 'agent', id: 'inbox' }} />
    </Provider>,
  )
  expect(screen.getByText('Nothing needs you')).toBeInTheDocument()
  expect(screen.queryByText('No session here')).not.toBeInTheDocument()
})
