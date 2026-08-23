/**
 * Daily notes, renderer side — the mechanism, not the policy.
 *
 * `openTodaysDailyAtom` used to decide *whether* to mint a daily by asking
 * GitHub how many collaborators the vault had. It no longer decides anything:
 * the vault says so itself via `dailyNotes`, `state/landing.ts` reads it, and
 * this layer is the verb. That is what makes ⌘⇧D still work in a vault that
 * keeps no daily notes automatically.
 *
 * What the collaborator check protected — never auto-creating a daily in a
 * shared vault — is now covered in `landing.test.ts` against the setting, and
 * being offline is no longer a case at all: there is no network call left to
 * fail.
 */
import { createStore } from 'jotai'
import { afterEach, describe, expect, it } from 'vitest'
import type { ResolvedVaultSettings, VaultSnapshot } from '@holi/shared'
import { installFakeHoli, type FakeHoli } from './helpers/fake-holi'
import { workspaceAtom } from '../src/renderer/src/state/panes'
import { activeRemoteAtom } from '../src/renderer/src/state/vaults'
import { openTodaysDailyAtom, sweepDailyAtom } from '../src/renderer/src/state/daily'

let holi: FakeHoli | null = null
afterEach(() => {
  holi?.restore()
  holi = null
})

const settings = (over: Partial<ResolvedVaultSettings> = {}): ResolvedVaultSettings => ({
  landing: { kind: 'daily' },
  dailyNotes: true,
  colorScheme: 'system',
  hooks: { relink: true, 'archive-done': false, 'normalize-md': true },
  maxCommittedFileBytes: 10 * 1024 * 1024,
  warnings: [],
  ...over,
})

const snap = (path: string): VaultSnapshot => ({
  docs: [{ path, kind: 'note', updatedAt: '2026-07-21T00:00:00Z' }],
  tasks: [],
  broken: [],
  files: [],
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

describe('sweepDailyAtom', () => {
  /** A rig whose sweep reports `result`, in a vault with `dailyNotes` as given. */
  function rig(result: { archived: number; deleted: number }, dailyNotes = true) {
    holi = installFakeHoli((op) => {
      if (op.path === 'settings.read') return settings({ dailyNotes })
      if (op.path === 'notes.sweepDaily') return result
      if (op.path === 'vaults.snapshot') return snap('x.md')
      return undefined
    })
    const store = createStore()
    store.set(activeRemoteAtom, 'me/notes')
    return store
  }

  it('commits once when the sweep changed something', async () => {
    const store = rig({ archived: 1, deleted: 0 })
    await store.set(sweepDailyAtom)
    expect(holi!.calls.map((c) => c.path)).toContain('sync.commitNow')
  })

  it('does not commit when the sweep was a no-op', async () => {
    const store = rig({ archived: 0, deleted: 0 })
    await store.set(sweepDailyAtom)
    // It really did sweep — this is not the early return in disguise.
    expect(holi!.calls.map((c) => c.path)).toContain('notes.sweepDaily')
    expect(holi!.calls.map((c) => c.path)).not.toContain('sync.commitNow')
  })

  it('does not sweep at all when the vault keeps no daily notes', async () => {
    // Off stops the archiving with the minting: the one place a background
    // process rewrites the vault's shape does not run behind your back either.
    const store = rig({ archived: 1, deleted: 0 }, false)
    await store.set(sweepDailyAtom)
    expect(holi!.calls.map((c) => c.path)).not.toContain('notes.sweepDaily')
    expect(holi!.calls.map((c) => c.path)).not.toContain('sync.commitNow')
  })

  it('never asks GitHub who the collaborators are', async () => {
    const store = rig({ archived: 0, deleted: 0 })
    await store.set(sweepDailyAtom)
    expect(holi!.calls.map((c) => c.path)).not.toContain('github.collaborators')
  })
})
