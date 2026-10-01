/**
 * The agent service follows the plugin that provides it: with that plugin
 * off in the vault there is none, so every "Ask" is hidden.
 */
import { VAULT_SETTING_DEFAULTS } from '@holi/shared'
import { atom, createStore } from 'jotai'
import { expect, test } from 'vitest'
import type { RendererPlugin } from '@/plugin-api/types'
import { agentSourceAtom, installedPluginsAtom } from '@/state/plugins'
import { vaultSettingsAtom } from '@/state/settings'
import { activeRemoteAtom } from '@/state/vaults'

const STAND_IN: RendererPlugin = {
  info: { id: 'stand-in', label: 'Stand-in', default: true },
  agent: {
    name: 'Helper',
    sessions: atom([]),
    targets: atom({ sessions: [], default: 'new' }),
    ask: atom(null, async () => ({ ok: true as const })),
    start: atom(null, async () => ({ ok: true as const })),
  },
}

test('there is no agent service while the plugin providing it is off', () => {
  const store = createStore()
  store.set(activeRemoteAtom, 'o/vault')
  store.set(installedPluginsAtom, [STAND_IN])
  expect(store.get(agentSourceAtom)).toBe(STAND_IN.agent)

  store.set(vaultSettingsAtom, {
    remote: 'o/vault',
    settings: {
      ...VAULT_SETTING_DEFAULTS,
      plugins: { vault: { 'stand-in': false }, localOff: [] },
      warnings: [],
    },
  })
  expect(store.get(agentSourceAtom)).toBeNull()
})
