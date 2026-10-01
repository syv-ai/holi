/**
 * Going Home, and the vault opening on it: which opener a resolved `home`
 * actually reaches.
 *
 * The *decision* is `lib/home-target.ts` and is tested there on plain values;
 * what is left here is the wiring, and the wiring is where a target opens the
 * wrong kind of tab. Each case asserts the workspace it produced rather than the
 * function it called, because the workspace is what the user sees.
 */
import { createStore } from 'jotai'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isAppBundlePath,
  VAULT_SETTING_DEFAULTS,
  type ResolvedVaultSettings,
  type VaultSnapshot,
} from '@holi/shared'
import { installFakeHoli, type FakeHoli } from './helpers/fake-holi'
import { homeTargetAtom, openHomeAtom, openLandingAtom } from '../src/renderer/src/state/home'
import { workspaceAtom } from '../src/renderer/src/state/panes'
import { coreContributionAtom } from '../src/renderer/src/state/plugins'
import { activeDocAtom, activeRemoteAtom, snapshotAtom } from '../src/renderer/src/state/vaults'

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

/** A vault holding one ordinary note plus an app (entry + manifest, which is
 *  what the app claim requires before it calls an app finished). */
const snapshot: VaultSnapshot = {
  docs: [
    { path: 'Notes/Standup.md', kind: 'note', updatedAt: '2026-08-22T00:00:00Z' },
    { path: '22-08-2026.md', kind: 'note', updatedAt: '2026-08-22T00:00:00Z' },
  ],
  claimed: {},
  files: [{ path: 'retro.app/index.html' }, { path: 'retro.app/app.yaml' }],
}

/** The views Home can name, as the registry would hold them. */
function registerViews(store: ReturnType<typeof createStore>): void {
  store.set(coreContributionAtom, {
    surfaces: ['home', 'board', 'agenda', 'mail'].map((kind) => ({
      kind,
      label: kind,
      icon: () => null,
      render: () => null,
      ...(kind === 'home' ? {} : { homeable: true as const }),
    })),
    rail: [],
    // An app is a folder document, finished once it has its manifest.
    claims: [
      {
        match: isAppBundlePath,
        folder: {
          surface: 'app',
          entry: 'index.html',
          ready: (path, has) => has(`${path}/app.yaml`),
        },
      },
    ],
  })
}

/** A store with a vault open and its snapshot in. */
function rig(over: Partial<ResolvedVaultSettings> = {}) {
  holi = installFakeHoli((op) => {
    if (op.path === 'settings.read') return settings(over)
    if (op.path === 'notes.getOrCreateDaily') return { path: '22-08-2026.md', created: false }
    if (op.path === 'vaults.snapshot') return snapshot
    return undefined
  })
  const store = createStore()
  registerViews(store)
  store.set(activeRemoteAtom, 'me/notes')
  store.set(snapshotAtom, snapshot)
  return store
}

const tabs = (store: ReturnType<typeof createStore>) => store.get(workspaceAtom).panes[0]!.tabs
const mints = () => holi!.calls.filter((c) => c.path === 'notes.getOrCreateDaily').length

describe('openHomeAtom', () => {
  it('shows an app that exists in the Home tab', async () => {
    const store = rig({ home: 'retro.app' })
    await store.set(openHomeAtom)
    expect(tabs(store)).toEqual([{ kind: 'surface', surface: 'home' }])
  })

  it('opens today’s daily, pinned', async () => {
    const store = rig({ home: 'daily' })
    await store.set(openHomeAtom)
    expect(tabs(store)).toEqual([{ kind: 'note', path: '22-08-2026.md' }])
    expect(store.get(activeDocAtom)?.path).toBe('22-08-2026.md')
  })

  it('opens a file, pinned, and makes it the active doc', async () => {
    const store = rig({ home: 'Notes/Standup.md' })
    await store.set(openHomeAtom)
    expect(tabs(store)).toEqual([{ kind: 'note', path: 'Notes/Standup.md' }])
    expect(tabs(store)[0]).not.toHaveProperty('preview', true)
    expect(store.get(activeDocAtom)?.path).toBe('Notes/Standup.md')
  })

  it.each(['board', 'agenda', 'mail'] as const)('opens the %s', async (kind) => {
    const store = rig({ home: kind })
    await store.set(openHomeAtom)
    expect(tabs(store)).toEqual([{ kind: 'surface', surface: kind }])
  })

  it.each([
    ['a missing app', { home: 'gone.app' }],
    ['a missing file', { home: 'deleted.md' }],
    ['the daily in a vault that keeps none', { home: 'daily', dailyNotes: false }],
  ])('opens the Home tab to explain %s', async (_, over) => {
    const store = rig(over)
    await store.set(openHomeAtom)
    expect(tabs(store)).toEqual([{ kind: 'surface', surface: 'home' }])
    expect(mints()).toBe(0)
  })

  it('does nothing at all when no vault is active', async () => {
    holi = installFakeHoli(() => undefined)
    const store = createStore()
    await store.set(openHomeAtom)
    expect(tabs(store)).toEqual([])
    expect(holi.calls.map((c) => c.path)).not.toContain('settings.read')
  })
})

describe('homeTargetAtom', () => {
  it('reads the cached settings once they are loaded', async () => {
    const store = rig({ home: 'board' })
    await store.set(openHomeAtom)
    expect(store.get(homeTargetAtom)).toEqual({ kind: 'surface', surface: 'board' })
  })
})

describe('openLandingAtom', () => {
  it('still mints today’s daily when Home is somewhere else', async () => {
    // `home` picks what you LOOK at; `dailyNotes` decides whether the vault
    // keeps a journal. A vault whose Home is its board must not quietly stop
    // journalling.
    const store = rig({ home: 'board' })
    await store.set(openLandingAtom)
    expect(mints()).toBe(1)
    expect(tabs(store)).toEqual([{ kind: 'surface', surface: 'board' }])
  })

  it('mints nothing when the vault keeps no daily notes', async () => {
    const store = rig({ home: 'board', dailyNotes: false })
    await store.set(openLandingAtom)
    expect(mints()).toBe(0)
    expect(tabs(store)).toEqual([{ kind: 'surface', surface: 'board' }])
  })

  it('opens a file naming today’s daily by path on the morning it is minted', async () => {
    const store = rig({ home: '22-08-2026.md' })
    await store.set(openLandingAtom)
    expect(tabs(store)).toEqual([{ kind: 'note', path: '22-08-2026.md' }])
  })
})

describe('going Home into a workspace that is not empty', () => {
  it('pins a note that is already open as a preview', async () => {
    const store = rig({ home: 'Notes/Standup.md' })
    store.set(workspaceAtom, {
      panes: [{ tabs: [{ kind: 'note', path: 'Notes/Standup.md', preview: true }], active: 0 }],
      active: 0,
    })

    await store.set(openHomeAtom)

    expect(tabs(store)).toEqual([{ kind: 'note', path: 'Notes/Standup.md' }])
  })

  it('focuses a singleton already open rather than opening a second', async () => {
    const store = rig({ home: 'board' })
    store.set(workspaceAtom, {
      panes: [
        {
          tabs: [
            { kind: 'note', path: 'Notes/Standup.md' },
            { kind: 'surface', surface: 'board' },
          ],
          active: 0,
        },
      ],
      active: 0,
    })

    await store.set(openHomeAtom)

    expect(tabs(store)).toEqual([
      { kind: 'note', path: 'Notes/Standup.md' },
      { kind: 'surface', surface: 'board' },
    ])
    expect(store.get(workspaceAtom).panes[0]!.active).toBe(1)
  })
})

describe('switching vaults', () => {
  // The settings cache is keyed by remote: a cache that only remembered "the
  // settings" would hand the second vault the first one's Home.
  it('reads the new vault’s settings, not the previous vault’s', async () => {
    holi = installFakeHoli((op) => {
      const remote = (op.input as { remote?: string } | undefined)?.remote
      if (op.path === 'settings.read') {
        return remote === 'me/second' ? settings({ home: 'mail' }) : settings({ home: 'board' })
      }
      if (op.path === 'notes.getOrCreateDaily') return { path: '22-08-2026.md', created: false }
      if (op.path === 'vaults.snapshot') return snapshot
      return undefined
    })
    const store = createStore()
    registerViews(store)
    store.set(snapshotAtom, snapshot)

    store.set(activeRemoteAtom, 'me/first')
    await store.set(openLandingAtom)
    expect(tabs(store)).toEqual([{ kind: 'surface', surface: 'board' }])

    store.set(activeRemoteAtom, 'me/second')
    await store.set(openLandingAtom)

    expect(tabs(store)).toContainEqual({ kind: 'surface', surface: 'mail' })
    expect(holi.calls.filter((c) => c.path === 'settings.read')).toHaveLength(2)
  })
})

describe('the cold-start read', () => {
  it('never asks GitHub who the collaborators are', async () => {
    const store = rig()
    await store.set(openLandingAtom)
    expect(holi!.calls.map((c) => c.path)).not.toContain('github.collaborators')
  })

  it('reads the settings once, however many openers run', async () => {
    const store = rig()
    await store.set(openLandingAtom)
    expect(holi!.calls.filter((c) => c.path === 'settings.read')).toHaveLength(1)
  })
})
