/**
 * Daily notes, renderer side: the mechanism, not the policy.
 *
 * `ensureTodaysDailyAtom` mints today's daily and says where it is, and
 * decides nothing: that is what makes ⇧⌘D work in a vault whose `dailyNotes`
 * is off. Being offline is no case at all: there is no network call to fail.
 */
import { createStore } from 'jotai'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type ResolvedVaultSettings,
  VAULT_SETTING_DEFAULTS,
  type VaultSnapshot,
} from '@holi/shared'
import { installFakeHoli, type FakeHoli } from '@/test/fake-holi'
import { activeRemoteAtom } from '@/state/vaults'
import { ensureTodaysDailyAtom } from '@/state/daily'

let holi: FakeHoli | null = null
afterEach(() => {
  holi?.restore()
  holi = null
})

const settings = (over: Partial<ResolvedVaultSettings> = {}): ResolvedVaultSettings => ({
  ...VAULT_SETTING_DEFAULTS,
  hooks: { ...VAULT_SETTING_DEFAULTS.hooks },
  dailyNotes: true,
  warnings: [],
  ...over,
})

const snap = (path: string): VaultSnapshot => ({
  docs: [{ path, kind: 'note', updatedAt: '2026-07-21T00:00:00Z' }],
  claimed: {},
  files: [],
  dirs: [],
  icons: {},
  ignored: [],
})

describe('ensureTodaysDailyAtom', () => {
  it('creates it and says where it is', async () => {
    holi = installFakeHoli((op) => {
      if (op.path === 'notes.getOrCreateDaily') return { path: '21-07-2026.md', created: true }
      if (op.path === 'vaults.snapshot') return snap('21-07-2026.md')
      return undefined
    })
    const store = createStore()
    store.set(activeRemoteAtom, 'me/notes')

    expect(await store.set(ensureTodaysDailyAtom)).toBe('21-07-2026.md')
    expect(holi.calls.map((c) => c.path)).toContain('vaults.snapshot')
    expect(holi.calls.map((c) => c.path)).toContain('notes.getOrCreateDaily')
  })

  it('mints one even in a vault that would not have auto-created it', async () => {
    // This atom is what ⇧⌘D calls, and ⇧⌘D has to work in a vault whose
    // `dailyNotes` is off: otherwise "off" means "the feature is gone" rather
    // than "stop doing this behind my back". Nothing here consults a setting.
    holi = installFakeHoli((op) => {
      if (op.path === 'settings.read') return settings({ dailyNotes: false })
      if (op.path === 'notes.getOrCreateDaily') return { path: '21-07-2026.md', created: true }
      if (op.path === 'vaults.snapshot') return snap('21-07-2026.md')
      return undefined
    })
    const store = createStore()
    store.set(activeRemoteAtom, 'org/shared')

    expect(await store.set(ensureTodaysDailyAtom)).toBe('21-07-2026.md')
    expect(holi.calls.map((c) => c.path)).toContain('notes.getOrCreateDaily')
  })

  it('asks nobody anything before minting', async () => {
    // Offline-complete is structural: there is no network call to fail, and
    // no settings read on this path either.
    holi = installFakeHoli((op) => {
      if (op.path === 'notes.getOrCreateDaily') return { path: '21-07-2026.md', created: false }
      if (op.path === 'vaults.snapshot') return snap('21-07-2026.md')
      return undefined
    })
    const store = createStore()
    store.set(activeRemoteAtom, 'me/notes')

    expect(await store.set(ensureTodaysDailyAtom)).toBe('21-07-2026.md')
    expect(holi.calls.map((c) => c.path)).not.toContain('github.collaborators')
    expect(holi.calls.map((c) => c.path)).not.toContain('settings.read')
  })

  it('does nothing without an active vault', async () => {
    holi = installFakeHoli(() => undefined)
    const store = createStore()
    expect(await store.set(ensureTodaysDailyAtom)).toBeNull()
    expect(holi.calls.map((c) => c.path)).not.toContain('notes.getOrCreateDaily')
  })
})
