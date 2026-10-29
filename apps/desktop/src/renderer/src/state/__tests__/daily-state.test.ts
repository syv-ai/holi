/**
 * Daily notes, renderer side — the mechanism, not the policy.
 *
 * `openTodaysDailyAtom` used to decide *whether* to mint a daily by asking
 * GitHub how many collaborators the vault had. It no longer decides anything:
 * the vault says so itself via `dailyNotes`, `state/home.ts` reads it, and
 * this layer is the verb. That is what makes ⌘⇧D still work in a vault that
 * keeps no daily notes automatically.
 *
 * What the collaborator check protected — never auto-creating a daily in a
 * shared vault — is now covered in `home.test.ts` against the setting, and
 * being offline is no longer a case at all: there is no network call left to
 * fail.
 */
import { createStore } from 'jotai'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type ResolvedVaultSettings,
  VAULT_SETTING_DEFAULTS,
  type VaultSnapshot,
} from '@holi/shared'
import { installFakeHoli, type FakeHoli } from '@/test/fake-holi'
import { workspaceAtom } from '@/state/panes'
import { activeRemoteAtom } from '@/state/vaults'
import { openTodaysDailyAtom } from '@/state/daily'

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

describe('openTodaysDailyAtom', () => {
  it('creates and opens a pinned tab', async () => {
    holi = installFakeHoli((op) => {
      if (op.path === 'notes.getOrCreateDaily') return { path: '21-07-2026.md', created: true }
      if (op.path === 'vaults.snapshot') return snap('21-07-2026.md')
      return undefined
    })
    const store = createStore()
    store.set(activeRemoteAtom, 'me/notes')

    expect(await store.set(openTodaysDailyAtom)).toBe('21-07-2026.md')
    expect(store.get(workspaceAtom).panes[0]!.tabs).toEqual([
      { kind: 'note', path: '21-07-2026.md' },
    ])
    expect(holi.calls.map((c) => c.path)).toContain('notes.getOrCreateDaily')
  })

  it('mints one even in a vault that would not have auto-created it', async () => {
    // The new contract, and the reason the gate moved out. This atom is what
    // ⌘⇧D calls, and ⌘⇧D has to work in a vault whose `dailyNotes` is off —
    // otherwise "off" means "the feature is gone" rather than "stop doing this
    // behind my back". Nothing here consults a setting at all.
    holi = installFakeHoli((op) => {
      if (op.path === 'settings.read') return settings({ dailyNotes: false })
      if (op.path === 'notes.getOrCreateDaily') return { path: '21-07-2026.md', created: true }
      if (op.path === 'vaults.snapshot') return snap('21-07-2026.md')
      return undefined
    })
    const store = createStore()
    store.set(activeRemoteAtom, 'org/shared')

    expect(await store.set(openTodaysDailyAtom)).toBe('21-07-2026.md')
    expect(holi.calls.map((c) => c.path)).toContain('notes.getOrCreateDaily')
  })

  it('asks nobody anything before minting', async () => {
    // Offline-complete used to be a fallback: the collaborator check defaulted
    // to "personal" when it threw, so daily notes worked on a plane by way of a
    // timeout. It is now structural — there is no network call to fail, and no
    // settings read on this path either.
    holi = installFakeHoli((op) => {
      if (op.path === 'notes.getOrCreateDaily') return { path: '21-07-2026.md', created: false }
      if (op.path === 'vaults.snapshot') return snap('21-07-2026.md')
      return undefined
    })
    const store = createStore()
    store.set(activeRemoteAtom, 'me/notes')

    expect(await store.set(openTodaysDailyAtom)).toBe('21-07-2026.md')
    expect(holi.calls.map((c) => c.path)).not.toContain('github.collaborators')
    expect(holi.calls.map((c) => c.path)).not.toContain('settings.read')
  })

  it('does nothing without an active vault', async () => {
    holi = installFakeHoli(() => undefined)
    const store = createStore()
    expect(await store.set(openTodaysDailyAtom)).toBeNull()
    expect(holi.calls.map((c) => c.path)).not.toContain('notes.getOrCreateDaily')
  })
})
