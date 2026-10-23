/**
 * The Agents mode opens on the new-session page whenever nothing is selected,
 * even in a vault whose `plugins.yaml` an older Holi wrote with `chat: false`:
 * the chat is built in, so a stale pin turns nothing off. The Inbox is its own
 * row, never the home.
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
import { CHAT_INFO } from './chat/info'
import { AGENT_INFO } from './agent/info'
import { AgentsMain } from './agent/renderer/agents/AgentsMain'

vi.mock('./agent/renderer/agent-cap', () => ({ agentCap: {} }))

// Core's plugin list and settings cache, reached as modules (a dynamic
// import: a plugin's code imports core only through @/plugin-api).
type Settable<T> = WritableAtom<T, [T], void>
const plugins = (await import('@/state/plugins')) as unknown as {
  installedPluginsAtom: Settable<readonly RendererPlugin[]>
}
const settings = (await import('@/state/settings')) as unknown as {
  vaultSettingsAtom: Settable<{ remote: string; settings: ResolvedVaultSettings } | null>
}

function vaultPinning(text: string) {
  const store = createStore()
  const infos = [AGENT_INFO, CHAT_INFO]
  store.set(plugins.installedPluginsAtom, [
    { info: AGENT_INFO },
    { info: CHAT_INFO, agentsSlot: { home: () => <p>New session page</p> } },
  ])
  store.set(activeRemoteAtom, 'o/r')
  const resolved = resolvePluginSettings(text, null, infos)
  store.set(settings.vaultSettingsAtom, {
    remote: 'o/r',
    settings: {
      ...VAULT_SETTING_DEFAULTS,
      plugins: resolved.plugins,
      pluginValues: resolved.values,
      warnings: resolved.warnings,
    } as ResolvedVaultSettings,
  })
  return store
}

test('a vault with chat: false pinned still opens on the new-session page', () => {
  const store = vaultPinning('plugins:\n  chat: false\n  agent: false\n')
  render(
    <Provider store={store}>
      <AgentsMain selection={null} />
    </Provider>,
  )
  expect(screen.getByText('New session page')).toBeInTheDocument()
  expect(screen.queryByText('Nothing needs you')).not.toBeInTheDocument()
})

test('the Inbox is its own view, not the home', () => {
  const store = vaultPinning('plugins: {}\n')
  render(
    <Provider store={store}>
      <AgentsMain selection={{ owner: 'agent', id: 'inbox' }} />
    </Provider>,
  )
  expect(screen.getByText('Nothing needs you')).toBeInTheDocument()
  expect(screen.queryByText('New session page')).not.toBeInTheDocument()
})
