/**
 * The landing dispatch — which opener a resolved target actually reaches.
 *
 * The *decision* is `lib/landing-target.ts` and is tested there on plain values;
 * what is left here is the wiring, and the wiring is where a target opens the
 * wrong kind of tab. Each case asserts the workspace it produced rather than the
 * function it called, because the workspace is what the user sees and the call
 * is an implementation detail.
 */
import { createStore } from 'jotai'
import { afterEach, describe, expect, it } from 'vitest'
import type { ResolvedVaultSettings, VaultSnapshot } from '@holi/shared'
import { installFakeHoli, type FakeHoli } from './helpers/fake-holi'
import { openLandingAtom } from '../src/renderer/src/state/landing'
import { workspaceAtom } from '../src/renderer/src/state/panes'
import { activeDocAtom, activeRemoteAtom, snapshotAtom } from '../src/renderer/src/state/vaults'

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

/** A vault holding one ordinary note plus an app (entry + manifest, which is
 *  what `appIdsAtom` requires before it will call an app real). */
const snapshot: VaultSnapshot = {
  docs: [
    { path: 'Notes/Standup.md', kind: 'note', updatedAt: '2026-08-22T00:00:00Z' },
    { path: '22-08-2026.md', kind: 'note', updatedAt: '2026-08-22T00:00:00Z' },
  ],
  tasks: [],
  broken: [],
  files: [{ path: '.holi/apps/retro/index.html' }, { path: '.holi/apps/retro/app.yaml' }],
}

/** A store with a vault open and its snapshot in, ready to land. */
function rig(over: Partial<ResolvedVaultSettings> = {}) {
  holi = installFakeHoli((op) => {
    if (op.path === 'settings.read') return settings(over)
    if (op.path === 'notes.getOrCreateDaily') return { path: '22-08-2026.md', created: false }
    if (op.path === 'vaults.snapshot') return snapshot
    return undefined
  })
  const store = createStore()
  store.set(activeRemoteAtom, 'me/notes')
  store.set(snapshotAtom, snapshot)
  return store
}

const tabs = (store: ReturnType<typeof createStore>) => store.get(workspaceAtom).panes[0]!.tabs

describe('openLandingAtom', () => {
  it('lands on today’s daily by default', async () => {
    const store = rig()
    await store.set(openLandingAtom)
    expect(tabs(store)).toEqual([{ kind: 'note', path: '22-08-2026.md' }])
    expect(holi!.calls.map((c) => c.path)).toContain('notes.getOrCreateDaily')
  })

  it('lands on a note, pinned, and makes it the active doc', async () => {
    const store = rig({ landing: { kind: 'note', path: 'Notes/Standup.md' } })
    await store.set(openLandingAtom)
    expect(tabs(store)).toEqual([{ kind: 'note', path: 'Notes/Standup.md' }])
    // Pinned, not preview: you land here to work, not to browse past it.
    expect(tabs(store)[0]).not.toHaveProperty('preview', true)
    expect(store.get(activeDocAtom)?.path).toBe('Notes/Standup.md')
  })

  it('lands on an app', async () => {
    const store = rig({ landing: { kind: 'app', appId: 'retro' } })
    await store.set(openLandingAtom)
    expect(tabs(store)).toEqual([{ kind: 'app', appId: 'retro' }])
  })

  it.each(['board', 'agenda', 'mail'] as const)('lands on the %s', async (kind) => {
    const store = rig({ landing: { kind } })
    await store.set(openLandingAtom)
    expect(tabs(store)).toEqual([{ kind }])
  })

  it('mints no daily when landing somewhere else', async () => {
    const store = rig({ landing: { kind: 'board' } })
    await store.set(openLandingAtom)
    expect(holi!.calls.map((c) => c.path)).not.toContain('notes.getOrCreateDaily')
  })
})

describe('openLandingAtom — landing on nothing', () => {
  it('leaves an empty pane when the vault keeps no daily and names no target', async () => {
    const store = rig({ dailyNotes: false })
    await store.set(openLandingAtom)
    // The empty-editor state, not a pane that should disappear.
    expect(tabs(store)).toEqual([])
    expect(store.get(workspaceAtom).panes[0]!.active).toBe(-1)
    expect(holi!.calls.map((c) => c.path)).not.toContain('notes.getOrCreateDaily')
  })

  it('does nothing at all when no vault is active', async () => {
    holi = installFakeHoli(() => undefined)
    const store = createStore()
    await store.set(openLandingAtom)
    expect(tabs(store)).toEqual([])
    expect(holi.calls.map((c) => c.path)).not.toContain('settings.read')
  })
})

describe('openLandingAtom — a rotted target', () => {
  it('falls back to the daily when the note is gone', async () => {
    const store = rig({ landing: { kind: 'note', path: 'deleted.md' } })
    await store.set(openLandingAtom)
    expect(tabs(store)).toEqual([{ kind: 'note', path: '22-08-2026.md' }])
  })

  it('falls back to the daily when the app is gone', async () => {
    const store = rig({ landing: { kind: 'app', appId: 'nope' } })
    await store.set(openLandingAtom)
    expect(tabs(store)).toEqual([{ kind: 'note', path: '22-08-2026.md' }])
  })

  it('falls back to NOTHING when the vault keeps no daily either', async () => {
    const store = rig({ landing: { kind: 'note', path: 'deleted.md' }, dailyNotes: false })
    await store.set(openLandingAtom)
    expect(tabs(store)).toEqual([])
    expect(holi!.calls.map((c) => c.path)).not.toContain('notes.getOrCreateDaily')
  })
})

describe('landing into a workspace that is not empty', () => {
  // Landing runs once per REMOTE, not once per launch, so a vault switch lands
  // into whatever tabs the last vault left behind. That is the only state where
  // `openPinned` and a plain open differ, and it is reachable.
  it('pins a note that is already open as a preview', async () => {
    const store = rig({ landing: { kind: 'note', path: 'Notes/Standup.md' } })
    store.set(workspaceAtom, {
      panes: [{ tabs: [{ kind: 'note', path: 'Notes/Standup.md', preview: true }], active: 0 }],
      active: 0,
    })

    await store.set(openLandingAtom)

    expect(tabs(store)).toHaveLength(1)
    // Landing on something is a commitment to it — it must not stay the one tab
    // a single click would replace.
    expect(tabs(store)[0]).toEqual({ kind: 'note', path: 'Notes/Standup.md' })
  })

  it('focuses a singleton already open rather than opening a second', async () => {
    const store = rig({ landing: { kind: 'board' } })
    store.set(workspaceAtom, {
      panes: [{ tabs: [{ kind: 'note', path: 'Notes/Standup.md' }, { kind: 'board' }], active: 0 }],
      active: 0,
    })

    await store.set(openLandingAtom)

    expect(tabs(store)).toEqual([{ kind: 'note', path: 'Notes/Standup.md' }, { kind: 'board' }])
    expect(store.get(workspaceAtom).panes[0]!.active).toBe(1)
  })
})

describe('switching vaults', () => {
  // The settings cache is keyed by remote, and this is what that key is for: a
  // cache that only remembered "the settings" would hand the second vault the
  // first one's answer, which is a vault opening on someone else's board.
  it('reads the new vault’s settings, not the previous vault’s', async () => {
    holi = installFakeHoli((op) => {
      const remote = (op.input as { remote?: string } | undefined)?.remote
      if (op.path === 'settings.read') {
        return remote === 'me/second'
          ? settings({ landing: { kind: 'mail' } })
          : settings({ landing: { kind: 'board' } })
      }
      if (op.path === 'vaults.snapshot') return snapshot
      return undefined
    })
    const store = createStore()
    store.set(snapshotAtom, snapshot)

    store.set(activeRemoteAtom, 'me/first')
    await store.set(openLandingAtom)
    expect(tabs(store)).toEqual([{ kind: 'board' }])

    store.set(activeRemoteAtom, 'me/second')
    await store.set(openLandingAtom)

    expect(tabs(store)).toContainEqual({ kind: 'mail' })
    expect(holi.calls.filter((c) => c.path === 'settings.read')).toHaveLength(2)
  })
})

describe('the cold-start read', () => {
  it('never asks GitHub who the collaborators are', async () => {
    // The whole point of `dailyNotes` replacing `isPersonalVault`: landing used
    // to cost a network round-trip before it could open anything, and a vault
    // opened on a plane got the answer by timing out.
    const store = rig()
    await store.set(openLandingAtom)
    expect(holi!.calls.map((c) => c.path)).not.toContain('github.collaborators')
  })

  it('reads the settings once, however many openers run', async () => {
    const store = rig()
    await store.set(openLandingAtom)
    const reads = holi!.calls.filter((c) => c.path === 'settings.read')
    expect(reads).toHaveLength(1)
  })
})
