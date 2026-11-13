/**
 * The vault list, the open vault, and the snapshot that arrives unasked.
 *
 * The channel carries the WHOLE vault every time, so the interesting property
 * is not that an update lands — it is that a *removal* lands. Anything that
 * merged frames instead of replacing them would pass a "the new note appeared"
 * test and still leave deleted notes on screen forever.
 */
import { createStore } from 'jotai'
import { flushAllBuffers, registerBuffer } from '@/lib/buffer-registry'
import { toast } from 'sonner'
import { shellWorkspaceAtom } from '@/state/shell-tabs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VaultSnapshot } from '@holi/shared'
import { installFakeHoli, type FakeHoli } from '@/test/fake-holi'
import { openDocumentRequestAtom, pendingHeadingAtom } from '@/state/open-document'
import { documentRunsAtom } from '@/state/document-runs'
import {
  activeRemoteAtom,
  addVaultAtom,
  createVaultAtom,
  loadSnapshotAtom,
  loadVaultsAtom,
  openVaultAtom,
  openedRemoteAtom,
  selectedVaultOpenAttemptedAtom,
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
  vi.restoreAllMocks()
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

// Model main's latest-IPC-wins epoch, not the renderer's selection. Awaiting
// `entered` proves each intent reached IPC before the next intent is sent.
function controlledOpens(count: number) {
  const opens = Array.from({ length: count }, () => ({
    entered: deferred<string>(),
    response: deferred<VaultSnapshot>(),
  }))
  let epoch = 0
  let physicalRemote: string | null = null
  holi = installFakeHoli(async (op) => {
    if (op.path !== 'vaults.open') return undefined
    const request = ++epoch
    const open = opens[request - 1]!
    const { remote } = op.input as { remote: string }
    open.entered.resolve(remote)
    const result = await open.response.promise
    if (epoch === request) physicalRemote = remote
    return result
  })
  return { opens, physicalRemote: () => physicalRemote }
}

function observeReady() {
  const ready = deferred<void>()
  const signal = vi.spyOn(window.holi.vault, 'openReady').mockImplementation(() => ready.resolve())
  return { ready: ready.promise, signal }
}

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

  it('recovers the selected vault before its superseded initial open became ready', async () => {
    const { opens, physicalRemote } = controlledOpens(3)
    const [initial, beta, recovery] = opens
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/alpha')
    unsubscribe = subscribeToVault(store)
    const { ready, signal } = observeReady()

    expect(store.get(selectedVaultOpenAttemptedAtom)).toBe(false)
    const initialOpen = store.set(openVaultAtom, 'syv-ai/alpha')
    expect(await initial!.entered.promise).toBe('syv-ai/alpha')
    expect(store.get(selectedVaultOpenAttemptedAtom)).toBe(true)
    holi!.pushOpen({ remote: 'syv-ai/beta', path: 'stale-beta.md' })
    expect(await beta!.entered.promise).toBe('syv-ai/beta')
    holi!.pushOpen({ remote: 'syv-ai/alpha', path: 'latest-alpha.md', heading: 'latest' })
    expect(await recovery!.entered.promise).toBe('syv-ai/alpha')
    expect(store.get(openedRemoteAtom)).toBeNull()
    expect(signal).not.toHaveBeenCalled()

    initial!.response.resolve(snapshot('stale-initial.md'))
    await expect(initialOpen).resolves.toBe(false)
    beta!.response.resolve(snapshot('stale-beta.md'))
    recovery!.response.resolve(snapshot('latest-alpha.md'))
    await ready

    expect(holi!.calls.map((call) => call.input)).toEqual([
      { remote: 'syv-ai/alpha' },
      { remote: 'syv-ai/beta' },
      { remote: 'syv-ai/alpha' },
    ])
    expect(physicalRemote()).toBe('syv-ai/alpha')
    expect(store.get(activeRemoteAtom)).toBe('syv-ai/alpha')
    expect(store.get(openedRemoteAtom)).toBe('syv-ai/alpha')
    expect(store.get(snapshotAtom)).toEqual(snapshot('latest-alpha.md'))
    expect(store.get(openDocumentRequestAtom)).toMatchObject({ path: 'latest-alpha.md' })
    expect(store.get(pendingHeadingAtom)).toEqual({ path: 'latest-alpha.md', heading: 'latest' })
    expect(signal).toHaveBeenCalledOnce()
  })

  it('catches a failed superseding flush and restores selection without retrying dirty buffers', async () => {
    const { opens, physicalRemote } = controlledOpens(2)
    const [beta, recovery] = opens
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/alpha')
    store.set(openedRemoteAtom, 'syv-ai/alpha')
    store.set(snapshotAtom, snapshot('alpha.md'))
    unsubscribe = subscribeToVault(store)
    holi!.pushOpen({ remote: 'syv-ai/alpha', path: 'alpha.md' })
    const workspace = store.get(shellWorkspaceAtom)
    const document = store.get(openDocumentRequestAtom)
    const { ready, signal } = observeReady()
    const errorShown = deferred<void>()
    const errorToast = vi.spyOn(toast, 'error').mockImplementation(() => {
      errorShown.resolve()
      return 'error'
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    holi!.pushOpen({ remote: 'syv-ai/beta', path: 'stale-beta.md' })
    expect(await beta!.entered.promise).toBe('syv-ai/beta')
    expect(store.get(openedRemoteAtom)).toBeNull()
    const flush = vi.fn(() => Promise.reject(new Error('write failed')))
    const unregister = registerBuffer(flush)
    try {
      holi!.pushOpen({ remote: 'syv-ai/gamma', path: 'failed-gamma.md' })
      await errorShown.promise
      expect(await recovery!.entered.promise).toBe('syv-ai/alpha')
      expect(errorToast).toHaveBeenCalledWith('Couldn’t open the document.', {
        description: 'write failed',
      })
      expect(store.get(openedRemoteAtom)).toBeNull()
      expect(signal).not.toHaveBeenCalled()
      beta!.response.resolve(snapshot('stale-beta.md'))
      recovery!.response.resolve(snapshot('alpha.md'))
      await ready

      expect(holi!.calls.map((call) => call.input)).toEqual([
        { remote: 'syv-ai/beta' },
        { remote: 'syv-ai/alpha' },
      ])
      expect(physicalRemote()).toBe('syv-ai/alpha')
      expect(store.get(activeRemoteAtom)).toBe('syv-ai/alpha')
      expect(store.get(openedRemoteAtom)).toBe('syv-ai/alpha')
      expect(store.get(snapshotAtom)).toEqual(snapshot('alpha.md'))
      expect(store.get(openDocumentRequestAtom)).toBe(document)
      expect(store.get(shellWorkspaceAtom)).toBe(workspace)
      expect(flush).toHaveBeenCalledOnce()
      expect(signal).toHaveBeenCalledOnce()
      // The dirty buffer is still registered, not removed to evade the error.
      await expect(flushAllBuffers()).rejects.toThrow('write failed')
      expect(flush).toHaveBeenCalledTimes(2)
    } finally {
      unregister()
    }
  })

  it('does not start recovery for a failed intent after the selection changed away and back', async () => {
    const { opens } = controlledOpens(1)
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/alpha')
    store.set(openedRemoteAtom, 'syv-ai/alpha')
    unsubscribe = subscribeToVault(store)
    holi!.pushOpen({ remote: 'syv-ai/beta', path: 'stale-beta.md' })
    await opens[0]!.entered.promise
    const flushing = deferred<void>()
    const flush = deferred<void>()
    const unregister = registerBuffer(() => {
      flushing.resolve()
      return flush.promise
    })
    const errorShown = deferred<void>()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(toast, 'error').mockImplementation(() => {
      errorShown.resolve()
      return 'error'
    })
    const { signal } = observeReady()
    try {
      holi!.pushOpen({ remote: 'syv-ai/gamma', path: 'failed-gamma.md' })
      await flushing.promise
      store.set(activeRemoteAtom, 'syv-ai/delta')
      store.set(activeRemoteAtom, 'syv-ai/alpha')
      flush.reject(new Error('write failed'))
      await errorShown.promise
      opens[0]!.response.resolve(snapshot('stale-beta.md'))

      expect(holi!.calls).toHaveLength(1)
      expect(store.get(activeRemoteAtom)).toBe('syv-ai/alpha')
      expect(store.get(openedRemoteAtom)).toBeNull()
      expect(store.get(openDocumentRequestAtom)).toBeNull()
      expect(signal).not.toHaveBeenCalled()
    } finally {
      unregister()
    }
  })

  it('fences recovery after a newer selection, including a return to the same remote', async () => {
    const { opens, physicalRemote } = controlledOpens(3)
    const [beta, recovery, latest] = opens
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/alpha')
    store.set(openedRemoteAtom, 'syv-ai/alpha')
    unsubscribe = subscribeToVault(store)
    const { signal } = observeReady()
    const published: VaultSnapshot[] = []
    const off = store.sub(snapshotAtom, () => published.push(store.get(snapshotAtom)))
    try {
      holi!.pushOpen({ remote: 'syv-ai/beta', path: 'stale-beta.md' })
      await beta!.entered.promise
      holi!.pushOpen({ remote: 'syv-ai/alpha', path: 'alpha.md' })
      await recovery!.entered.promise
      store.set(activeRemoteAtom, 'syv-ai/gamma')
      store.set(activeRemoteAtom, 'syv-ai/alpha')
      expect(store.get(selectedVaultOpenAttemptedAtom)).toBe(false)
      const latestOpen = store.set(openVaultAtom, 'syv-ai/alpha')
      await latest!.entered.promise
      recovery!.response.resolve(snapshot('stale-recovery.md'))
      beta!.response.resolve(snapshot('stale-beta.md'))
      latest!.response.resolve(snapshot('selected-alpha.md'))
      await expect(latestOpen).resolves.toBe(true)

      expect(physicalRemote()).toBe('syv-ai/alpha')
      expect(store.get(activeRemoteAtom)).toBe('syv-ai/alpha')
      expect(store.get(openedRemoteAtom)).toBe('syv-ai/alpha')
      expect(published).toEqual([snapshot('selected-alpha.md')])
      expect(signal).not.toHaveBeenCalled()
      expect(holi!.calls).toHaveLength(3)
    } finally {
      off()
    }
  })

  it('lets a newer same-vault document intent replace an in-flight recovery', async () => {
    const { opens, physicalRemote } = controlledOpens(3)
    const [beta, staleRecovery, recovery] = opens
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/alpha')
    store.set(openedRemoteAtom, 'syv-ai/alpha')
    unsubscribe = subscribeToVault(store)
    const { ready, signal } = observeReady()
    const published: VaultSnapshot[] = []
    const off = store.sub(snapshotAtom, () => published.push(store.get(snapshotAtom)))
    try {
      holi!.pushOpen({ remote: 'syv-ai/beta', path: 'stale-beta.md' })
      await beta!.entered.promise
      holi!.pushOpen({ remote: 'syv-ai/alpha', path: 'older-alpha.md' })
      await staleRecovery!.entered.promise
      holi!.pushOpen({ remote: 'syv-ai/alpha', path: 'latest-alpha.md' })
      expect(await recovery!.entered.promise).toBe('syv-ai/alpha')
      expect(store.get(openedRemoteAtom)).toBeNull()
      staleRecovery!.response.resolve(snapshot('stale-recovery.md'))
      beta!.response.resolve(snapshot('stale-beta.md'))
      recovery!.response.resolve(snapshot('latest-alpha.md'))
      await ready

      expect(physicalRemote()).toBe('syv-ai/alpha')
      expect(store.get(activeRemoteAtom)).toBe('syv-ai/alpha')
      expect(store.get(openedRemoteAtom)).toBe('syv-ai/alpha')
      expect(store.get(openDocumentRequestAtom)).toMatchObject({ path: 'latest-alpha.md' })
      expect(published).toEqual([snapshot('latest-alpha.md')])
      expect(signal).toHaveBeenCalledOnce()
      expect(holi!.calls).toHaveLength(3)
    } finally {
      off()
    }
  })

  it('lets a newer cross-vault document intent supersede recovery without stale readiness', async () => {
    const { opens, physicalRemote } = controlledOpens(3)
    const [beta, recovery, gamma] = opens
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/alpha')
    store.set(openedRemoteAtom, 'syv-ai/alpha')
    unsubscribe = subscribeToVault(store)
    const { signal } = observeReady()
    const documentOpened = deferred<void>()
    const off = store.sub(openDocumentRequestAtom, () => {
      if (store.get(openDocumentRequestAtom)?.path === 'gamma.md') documentOpened.resolve()
    })
    const published: VaultSnapshot[] = []
    const offSnapshot = store.sub(snapshotAtom, () => published.push(store.get(snapshotAtom)))
    try {
      holi!.pushOpen({ remote: 'syv-ai/beta', path: 'stale-beta.md' })
      await beta!.entered.promise
      holi!.pushOpen({ remote: 'syv-ai/alpha', path: 'alpha.md' })
      await recovery!.entered.promise
      holi!.pushOpen({ remote: 'syv-ai/gamma', path: 'gamma.md' })
      expect(await gamma!.entered.promise).toBe('syv-ai/gamma')
      expect(store.get(openedRemoteAtom)).toBeNull()
      recovery!.response.resolve(snapshot('stale-recovery.md'))
      beta!.response.resolve(snapshot('stale-beta.md'))
      gamma!.response.resolve(snapshot('gamma.md'))
      await documentOpened.promise

      expect(physicalRemote()).toBe('syv-ai/gamma')
      expect(store.get(activeRemoteAtom)).toBe('syv-ai/gamma')
      expect(store.get(openedRemoteAtom)).toBe('syv-ai/gamma')
      expect(published).toEqual([snapshot('gamma.md')])
      expect(signal).not.toHaveBeenCalled()
      expect(holi!.calls).toHaveLength(3)
    } finally {
      off()
      offSnapshot()
    }
  })

  it('keeps shell open ownership across document-selected vaults and cleared readiness', async () => {
    const { opens, physicalRemote } = controlledOpens(3)
    const [beta, gamma, recovery] = opens
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/alpha')
    unsubscribe = subscribeToVault(store)
    const betaDocument = deferred<void>()
    const off = store.sub(openDocumentRequestAtom, () => {
      if (store.get(openDocumentRequestAtom)?.path === 'beta.md') betaDocument.resolve()
    })
    const { ready } = observeReady()
    try {
      holi!.pushOpen({ remote: 'syv-ai/beta', path: 'beta.md' })
      await beta!.entered.promise
      beta!.response.resolve(snapshot('beta.md'))
      await betaDocument.promise
      // VaultHost did not start this open, but must recognize its ownership
      // of the new selection revision even after readiness clears again.
      expect(store.get(activeRemoteAtom)).toBe('syv-ai/beta')
      expect(store.get(selectedVaultOpenAttemptedAtom)).toBe(true)
      holi!.pushOpen({ remote: 'syv-ai/gamma', path: 'stale-gamma.md' })
      await gamma!.entered.promise
      expect(store.get(openedRemoteAtom)).toBeNull()
      expect(store.get(selectedVaultOpenAttemptedAtom)).toBe(true)
      holi!.pushOpen({ remote: 'syv-ai/beta', path: 'latest-beta.md' })
      expect(await recovery!.entered.promise).toBe('syv-ai/beta')
      expect(store.get(selectedVaultOpenAttemptedAtom)).toBe(true)
      gamma!.response.resolve(snapshot('stale-gamma.md'))
      recovery!.response.resolve(snapshot('latest-beta.md'))
      await ready

      expect(physicalRemote()).toBe('syv-ai/beta')
      expect(store.get(activeRemoteAtom)).toBe('syv-ai/beta')
      expect(store.get(openedRemoteAtom)).toBe('syv-ai/beta')
      expect(store.get(selectedVaultOpenAttemptedAtom)).toBe(true)
      expect(store.get(openDocumentRequestAtom)).toMatchObject({ path: 'latest-beta.md' })
      expect(holi!.calls).toHaveLength(3)
    } finally {
      off()
    }
  })

  it('reports recovery failure without retry loops or false readiness', async () => {
    const { opens } = controlledOpens(2)
    const [beta, recovery] = opens
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/alpha')
    store.set(openedRemoteAtom, 'syv-ai/alpha')
    unsubscribe = subscribeToVault(store)
    const { signal } = observeReady()
    const errorShown = deferred<void>()
    vi.spyOn(toast, 'error').mockImplementation(() => {
      errorShown.resolve()
      return 'error'
    })

    holi!.pushOpen({ remote: 'syv-ai/beta', path: 'stale-beta.md' })
    await beta!.entered.promise
    holi!.pushOpen({ remote: 'syv-ai/alpha', path: 'alpha.md' })
    await recovery!.entered.promise
    beta!.response.resolve(snapshot('stale-beta.md'))
    recovery!.response.reject(new Error('open failed'))
    await errorShown.promise

    expect(toast.error).toHaveBeenCalledWith('Couldn’t open the document.', {
      description: 'open failed',
    })
    expect(store.get(activeRemoteAtom)).toBe('syv-ai/alpha')
    expect(store.get(openedRemoteAtom)).toBeNull()
    expect(signal).not.toHaveBeenCalled()
    expect(holi!.calls).toHaveLength(2)
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
