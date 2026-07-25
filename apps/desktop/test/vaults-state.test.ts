/**
 * The vault list, the open vault, and the snapshot that arrives unasked.
 *
 * The channel carries the WHOLE vault every time, so the interesting property
 * is not that an update lands — it is that a *removal* lands. Anything that
 * merged frames instead of replacing them would pass a "the new note appeared"
 * test and still leave deleted notes on screen forever.
 */
import { createStore } from 'jotai'
import { afterEach, describe, expect, it } from 'vitest'
import type { VaultSnapshot } from '@holi/shared'
import { installFakeHoli, type FakeHoli } from './helpers/fake-holi'
import {
  activeRemoteAtom,
  addVaultAtom,
  createVaultAtom,
  loadVaultsAtom,
  openVaultAtom,
  snapshotAtom,
  subscribeToVault,
  vaultsAtom,
} from '../src/renderer/src/state/vaults'

let holi: FakeHoli | null = null
let unsubscribe: (() => void) | null = null
afterEach(() => {
  unsubscribe?.()
  unsubscribe = null
  holi?.restore()
  holi = null
})

const snapshot = (...paths: string[]): VaultSnapshot => ({
  docs: paths.map((path) => ({ path, kind: 'note' as const, updatedAt: '2026-07-22T00:00:00Z' })),
  tasks: [],
  broken: [],
  files: [],
})

const entry = (remote: string) => ({
  remote,
  path: `/tmp/${remote}`,
  name: remote.split('/')[1]!,
  lastOpenedAt: '2026-07-22T00:00:00Z',
})

describe('vaults', () => {
  it('lists vaults and makes the first one active', async () => {
    holi = installFakeHoli(() => [entry('syv-ai/notes'), entry('syv-ai/other')])
    const store = createStore()

    await store.set(loadVaultsAtom)

    expect(store.get(vaultsAtom).map((v) => v.remote)).toEqual(['syv-ai/notes', 'syv-ai/other'])
    expect(store.get(activeRemoteAtom)).toBe('syv-ai/notes')
  })

  it('replaces the snapshot wholesale, so a deleted note disappears', async () => {
    holi = installFakeHoli()
    const store = createStore()
    unsubscribe = subscribeToVault(store)

    holi.pushSnapshot(snapshot('a.md', 'b.md'))
    expect(store.get(snapshotAtom).docs.map((d) => d.path)).toEqual(['a.md', 'b.md'])

    holi.pushSnapshot(snapshot('a.md'))

    // The assertion that matters. A reducer that merged frames would leave
    // `b.md` in the tree until the next vault switch.
    expect(store.get(snapshotAtom).docs.map((d) => d.path)).toEqual(['a.md'])
  })

  it('opening a vault switches the active remote and takes its snapshot', async () => {
    holi = installFakeHoli((op) => (op.path === 'vaults.open' ? snapshot('other.md') : undefined))
    const store = createStore()

    await store.set(openVaultAtom, 'syv-ai/other')

    expect(store.get(activeRemoteAtom)).toBe('syv-ai/other')
    // `vaults.open` starts the watcher and the sync loop in main and hands back
    // the snapshot of the vault that is now live — a second `vaults.snapshot`
    // read could only disagree with it.
    expect(store.get(snapshotAtom).docs.map((d) => d.path)).toEqual(['other.md'])
    expect(holi.calls.map((c) => c.path)).toEqual(['vaults.open'])
  })
})

/**
 * FR-7 and FR-8. Both procedures existed, were tested, and had no caller at all
 * — the shell listed vaults and opened them, and offered no way for one to get
 * into the list. Found by signing in on a clean machine and finding nothing to
 * click.
 */
describe('getting a vault in the first place', () => {
  it('adds an existing repo and makes it the open vault', async () => {
    holi = installFakeHoli((op) => {
      if (op.path === 'vaults.add') return snapshot('README.md')
      if (op.path === 'vaults.list') return [entry('syv-ai/notes')]
      return undefined
    })
    const store = createStore()

    await store.set(addVaultAtom, 'syv-ai/notes')

    expect(store.get(activeRemoteAtom)).toBe('syv-ai/notes')
    expect(store.get(snapshotAtom).docs.map((d) => d.path)).toEqual(['README.md'])
    // The list has to be re-read, or the vault that was just added is open and
    // absent from the dropdown at the same time.
    expect(store.get(vaultsAtom).map((v) => v.remote)).toEqual(['syv-ai/notes'])
  })

  it('creates a new vault, sets it active, and returns the remote without refreshing the list', async () => {
    holi = installFakeHoli((op) => {
      if (op.path === 'vaults.create') return snapshot('AGENTS.md', 'README.md')
      if (op.path === 'vaults.list') return [entry('syv-ai/fresh')]
      return undefined
    })
    const store = createStore()

    const remote = await store.set(createVaultAtom, { name: 'fresh', owner: 'syv-ai' })

    expect(remote).toBe('syv-ai/fresh')
    expect(store.get(activeRemoteAtom)).toBe('syv-ai/fresh')
    expect(store.get(snapshotAtom).docs.map((d) => d.path)).toEqual(['AGENTS.md', 'README.md'])
    // The list is deliberately NOT re-read here — the ritual shows a success
    // step before entering, and refreshing would unmount it by flipping the
    // first-run gate. Entry (loadVaults) is a separate, explicit step.
    expect(store.get(vaultsAtom)).toEqual([])
  })

  it('surfaces a refusal instead of leaving a half-open vault', async () => {
    // `vaults.add` throws when the clone fails — no network, no access, a name
    // that does not exist. Swallowing it would leave the dropdown unchanged and
    // nothing on screen saying why.
    holi = installFakeHoli(() => {
      throw new Error('could not clone syv-ai/nope')
    })
    const store = createStore()

    await expect(store.set(addVaultAtom, 'syv-ai/nope')).rejects.toThrow(/could not clone/)
    expect(store.get(activeRemoteAtom)).toBeNull()
  })
})
