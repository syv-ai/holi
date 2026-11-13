/**
 * The vault list, the open vault, and the snapshot that arrives unasked.
 *
 * The channel carries the WHOLE vault every time, so the interesting property
 * is not that an update lands — it is that a *removal* lands. Anything that
 * merged frames instead of replacing them would pass a "the new note appeared"
 * test and still leave deleted notes on screen forever.
 */
import { createStore } from 'jotai'
import { registerBuffer } from '@/lib/buffer-registry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VaultSnapshot } from '@holi/shared'
import { installFakeHoli, type FakeHoli } from '@/test/fake-holi'
import { openDocumentRequestAtom } from '@/state/open-document'
import { documentRunsAtom } from '@/state/document-runs'
import {
  activeRemoteAtom,
  addVaultAtom,
  createVaultAtom,
  loadSnapshotAtom,
  loadVaultsAtom,
  openVaultAtom,
  openedRemoteAtom,
  snapshotAtom,
  subscribeToVault,
  vaultsAtom,
} from '@/state/vaults'

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
  claimed: {},
  files: [],
  dirs: [],
  icons: {},
  ignored: [],
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

  it('does not let an older open overwrite a newer vault selection', async () => {
    const responses = new Map<string, (value: VaultSnapshot) => void>()
    holi = installFakeHoli((op) => {
      if (op.path !== 'vaults.open') return undefined
      const remote = (op.input as { remote: string }).remote
      return new Promise<VaultSnapshot>((resolve) => responses.set(remote, resolve))
    })
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/alpha')

    const alpha = store.set(openVaultAtom, 'syv-ai/alpha')
    await vi.waitFor(() => expect(responses.has('syv-ai/alpha')).toBe(true))
    store.set(activeRemoteAtom, 'syv-ai/beta')
    const beta = store.set(openVaultAtom, 'syv-ai/beta')
    await vi.waitFor(() => expect(responses.has('syv-ai/beta')).toBe(true))

    responses.get('syv-ai/beta')!(snapshot('beta.md'))
    await beta
    responses.get('syv-ai/alpha')!(snapshot('alpha.md'))
    await alpha

    expect(store.get(activeRemoteAtom)).toBe('syv-ai/beta')
    expect(store.get(snapshotAtom).docs.map((doc) => doc.path)).toEqual(['beta.md'])
    expect(store.get(openedRemoteAtom)).toBe('syv-ai/beta')
  })

  it('rejects an open after the selection changes before another open starts', async () => {
    let resolveOpen!: (value: VaultSnapshot) => void
    holi = installFakeHoli(() => new Promise<VaultSnapshot>((resolve) => (resolveOpen = resolve)))
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/alpha')

    const pending = store.set(openVaultAtom, 'syv-ai/alpha')
    await vi.waitFor(() => expect(holi!.calls).toHaveLength(1))
    store.set(activeRemoteAtom, 'syv-ai/beta')
    resolveOpen(snapshot('alpha.md'))

    await expect(pending).resolves.toBe(false)
    expect(store.get(activeRemoteAtom)).toBe('syv-ai/beta')
    expect(store.get(snapshotAtom).docs).toEqual([])
    expect(store.get(openedRemoteAtom)).toBeNull()
  })

  it('uses the latest intent for A→B→A and overlapping same-vault opens', async () => {
    const responses: ((value: VaultSnapshot) => void)[] = []
    holi = installFakeHoli(() => new Promise<VaultSnapshot>((resolve) => responses.push(resolve)))
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/alpha')

    const first = store.set(openVaultAtom, 'syv-ai/alpha')
    await vi.waitFor(() => expect(responses).toHaveLength(1))
    store.set(activeRemoteAtom, 'syv-ai/beta')
    store.set(activeRemoteAtom, 'syv-ai/alpha')
    const second = store.set(openVaultAtom, 'syv-ai/alpha')
    await vi.waitFor(() => expect(responses).toHaveLength(2))

    responses[1]!(snapshot('latest.md'))
    await expect(second).resolves.toBe(true)
    responses[0]!(snapshot('stale.md'))
    await expect(first).resolves.toBe(false)

    expect(store.get(activeRemoteAtom)).toBe('syv-ai/alpha')
    expect(store.get(snapshotAtom).docs.map((doc) => doc.path)).toEqual(['latest.md'])
    expect(store.get(openedRemoteAtom)).toBe('syv-ai/alpha')
  })

  it('supersedes a pending cross-vault document open with a same-vault intent', async () => {
    const responses: ((value: VaultSnapshot) => void)[] = []
    holi = installFakeHoli((op) =>
      op.path === 'vaults.open'
        ? new Promise<VaultSnapshot>((resolve) => responses.push(resolve))
        : undefined,
    )
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/alpha')
    store.set(openedRemoteAtom, 'syv-ai/alpha')
    unsubscribe = subscribeToVault(store)

    holi.pushOpen({ remote: 'syv-ai/beta', path: 'beta.md' })
    await vi.waitFor(() => expect(responses).toHaveLength(1))
    holi.pushOpen({ remote: 'syv-ai/alpha', path: 'alpha.md' })
    expect(store.get(openDocumentRequestAtom)).toMatchObject({ path: 'alpha.md' })

    responses[0]!(snapshot('stale-beta.md'))
    await vi.waitFor(() => expect(holi!.calls).toHaveLength(2))
    expect((holi!.calls[1]!.input as { remote: string }).remote).toBe('syv-ai/alpha')
    responses[1]!(snapshot('alpha.md'))
    await vi.waitFor(() =>
      expect(store.get(snapshotAtom).docs.map((doc) => doc.path)).toEqual(['alpha.md']),
    )

    expect(store.get(activeRemoteAtom)).toBe('syv-ai/alpha')
    expect(store.get(openedRemoteAtom)).toBe('syv-ai/alpha')
  })

  it('clears document runs only when a different remote becomes active', async () => {
    holi = installFakeHoli((op) => (op.path === 'vaults.open' ? snapshot('shared.md') : undefined))
    const store = createStore()
    store.set(documentRunsAtom, { 'shared.md': { status: 'completed' } } as never)
    store.set(activeRemoteAtom, 'syv-ai/alpha')
    expect(store.get(documentRunsAtom)).toEqual({})
    store.set(documentRunsAtom, { 'shared.md': { status: 'completed' } } as never)
    store.set(activeRemoteAtom, 'syv-ai/alpha')
    expect(store.get(documentRunsAtom)).toHaveProperty('shared.md')

    await store.set(openVaultAtom, 'syv-ai/beta')
    expect(store.get(documentRunsAtom)).toEqual({})
  })

  it('waits for dirty buffers before opening another vault', async () => {
    holi = installFakeHoli((op) => (op.path === 'vaults.open' ? snapshot('beta.md') : undefined))
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/alpha')
    let finishFlush!: () => void
    const unregister = registerBuffer(() => new Promise<void>((resolve) => (finishFlush = resolve)))

    const pending = store.set(openVaultAtom, 'syv-ai/beta')
    await vi.waitFor(() => expect(finishFlush).toBeTypeOf('function'))
    expect(holi.calls).toEqual([])
    finishFlush()
    await expect(pending).resolves.toBe(true)
    unregister()
    expect(holi.calls.map((call) => call.path)).toEqual(['vaults.open'])
  })

  it('does not open another vault when flushing a buffer fails', async () => {
    holi = installFakeHoli()
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/alpha')
    const unregister = registerBuffer(() => Promise.reject(new Error('write failed')))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(store.set(openVaultAtom, 'syv-ai/beta')).rejects.toThrow('write failed')
    unregister()
    error.mockRestore()
    expect(holi.calls).toEqual([])
    expect(store.get(activeRemoteAtom)).toBe('syv-ai/alpha')
  })

  it('does not open a stale remote if selection changes while buffers flush', async () => {
    holi = installFakeHoli()
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/alpha')
    let finishFlush!: () => void
    const unregister = registerBuffer(() => new Promise<void>((resolve) => (finishFlush = resolve)))

    const pending = store.set(openVaultAtom, 'syv-ai/beta')
    await vi.waitFor(() => expect(finishFlush).toBeTypeOf('function'))
    store.set(activeRemoteAtom, 'syv-ai/gamma')
    finishFlush()
    await expect(pending).resolves.toBe(false)
    unregister()
    expect(holi.calls).toEqual([])
    expect(store.get(activeRemoteAtom)).toBe('syv-ai/gamma')
  })

  it('does not publish a snapshot query for a no-longer-active vault', async () => {
    let resolveSnapshot!: (value: VaultSnapshot) => void
    holi = installFakeHoli(
      () => new Promise<VaultSnapshot>((resolve) => (resolveSnapshot = resolve)),
    )
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/alpha')

    const pending = store.set(loadSnapshotAtom)
    await vi.waitFor(() => expect(holi!.calls).toHaveLength(1))
    store.set(activeRemoteAtom, 'syv-ai/beta')
    resolveSnapshot(snapshot('alpha.md'))
    await pending

    expect(store.get(snapshotAtom).docs).toEqual([])
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
 * Adopt and create. Both procedures existed, were tested, and had no caller at all
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

  it('creates a new vault and returns the remote, activating nothing', async () => {
    holi = installFakeHoli((op) => {
      if (op.path === 'vaults.create') return snapshot('AGENTS.md', 'README.md')
      if (op.path === 'vaults.list') return [entry('syv-ai/fresh')]
      return undefined
    })
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/already-open')

    const remote = await store.set(createVaultAtom, { name: 'fresh', owner: 'syv-ai' })

    expect(remote).toBe('syv-ai/fresh')
    // **Activation used to happen here** and was moved out. Setting the active
    // remote is what makes the Shell open and LAND a vault, so doing it at
    // creation landed the vault before the ritual's settings act had asked
    // anything: the answers were written to a vault that had already read the
    // seeded defaults, and only took effect on the next launch. The ritual
    // activates on "Open vault" instead.
    expect(store.get(activeRemoteAtom)).toBe('syv-ai/already-open')
    // The list is deliberately NOT re-read here: the ritual shows a success
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
