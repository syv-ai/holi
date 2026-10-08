/**
 * Every method the frame's bridge may call and main answers is a capability
 * that opens the app door, in core or in a plugin of this build: one left out
 * would be a call that an app makes and nothing answers.
 */
import { expect, it } from 'vitest'
import { APP_METHODS, RENDERER_METHODS } from './apps/shared/bridge'
import { agentCapabilities, AGENT_NAMESPACES } from './agent/main/host/capabilities'
import { createCapabilityRegistry } from '../main/capabilities/registry'
import { vaultCapabilities, VAULT_NAMESPACES } from '../main/capabilities/vault-caps'
import { taskCapabilities, TASK_NAMESPACES } from '../main/vault/task-capabilities'
import type { GoogleAccountsManager } from './google/main/accounts'
import { googleCapabilities, GOOGLE_NAMESPACES } from './google/main/capabilities'
import { PDF_NAMESPACES, pdfCapabilities } from './pdf/main/capabilities'
import { appsCapabilities, storeCapabilities } from './apps/main/capabilities'

it('answers every bridge method that is not the renderer’s at the app door', () => {
  const registry = createCapabilityRegistry()
  registry.register(
    VAULT_NAMESPACES,
    vaultCapabilities({
      updateSkills: async () => ({ summary: '', conflicts: null }),
      pendingSkills: async () => [],
    }),
  )
  registry.register(TASK_NAMESPACES, taskCapabilities({ today: () => '2026-10-01' }))
  registry.register(
    AGENT_NAMESPACES,
    agentCapabilities({
      sessions: {} as never,
      terminals: {} as never,
      liveRemote: () => null,
      commitNow: async () => null,
    }),
  )
  registry.register(
    GOOGLE_NAMESPACES,
    googleCapabilities({
      accounts: {} as GoogleAccountsManager,
      dataFor: async () => null,
      calendarPrefs: { read: async () => ({}), set: async () => {} },
      imagePrefs: { read: async () => [], allow: async () => {}, clear: async () => {} },
    }),
  )
  registry.register(
    ['pdf'],
    pdfCapabilities({
      signatures: { read: async () => '[]', write: async () => {} },
      typst: async () => null,
    }),
  )
  registry.register(
    ['apps'],
    appsCapabilities({
      events: { emit: () => {} },
      appDoor: () => {
        throw new Error('not called')
      },
      grants: { status: async () => ({ codeHash: '', affordances: [] }), grant: async () => true },
    }),
  )
  registry.register(['store'], storeCapabilities())

  const open = new Set(registry.names('app'))
  const renderer: readonly string[] = RENDERER_METHODS
  const unanswered = APP_METHODS.filter((m) => !renderer.includes(m) && !open.has(m))
  expect(unanswered).toEqual([])
})
