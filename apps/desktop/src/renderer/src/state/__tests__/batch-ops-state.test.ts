/**
 * The renderer half of the batch note ops. What matters is the ORDER — flush,
 * commit a clean restore point, run the batch, commit again — so a whole batch
 * lands as one commit-pair on safe ground. The open tabs following a move and
 * closing on a delete are the shell's, done by the caller (the file tree).
 */
import { createStore } from 'jotai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VaultSnapshot } from '@holi/shared'
import { installFakeHoli, type FakeHoli } from '@/test/fake-holi'
import {
  activeRemoteAtom,
  deleteManyAtom,
  moveNotesAtom,
  openVaultAtom,
  openedRemoteAtom,
} from '@/state/vaults'
import { registerBuffer } from '@/lib/buffer-registry'
import { openTabAtom, workspaceOfAtom } from '@/state/shell-tabs'
import { allTabs } from '@/state/shell-workspace'

let holi: FakeHoli | null = null
afterEach(() => {
  holi?.restore()
  holi = null
})

const emptySnapshot = (): VaultSnapshot => ({
  docs: [],
  claimed: {},
  files: [],
  dirs: [],
  icons: {},
  ignored: [],
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

describe('moveNotesAtom', () => {
  it('flushes, commits, moves, commits', async () => {
    holi = installFakeHoli((op) => {
      if (op.path === 'notes.move') return { rewritten: [] }
      if (op.path === 'vaults.snapshot') return emptySnapshot()
      return undefined
    })
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/notes')
    store.set(openedRemoteAtom, 'syv-ai/notes')

    await store.set(moveNotesAtom, { moves: [{ from: 'projects/a.md', to: 'work/a.md' }] })

    expect(holi.calls.map((c) => c.path)).toEqual([
      'sync.commitNow',
      'notes.move',
      'vaults.snapshot',
      'sync.commitNow',
    ])
  })

  it('does not start while a vault open already owns main', async () => {
    const opened = deferred<VaultSnapshot>()
    holi = installFakeHoli((op) => (op.path === 'vaults.open' ? opened.promise : undefined))
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/notes')
    store.set(openedRemoteAtom, 'syv-ai/notes')
    const pendingOpen = store.set(openVaultAtom, 'other/repo')
    await vi.waitFor(() =>
      expect(holi!.calls.some((call) => call.path === 'vaults.open')).toBe(true),
    )

    await store.set(moveNotesAtom, { moves: [{ from: 'a.md', to: 'a.mdx' }] })

    expect(holi.calls.filter((call) => call.path === 'sync.commitNow')).toHaveLength(0)
    expect(holi.calls.filter((call) => call.path === 'notes.move')).toHaveLength(0)
    opened.resolve(emptySnapshot())
    await pendingOpen
  })

  it('stops after an open is initiated during the initial buffer flush', async () => {
    const flush = deferred<void>()
    const opened = deferred<VaultSnapshot>()
    holi = installFakeHoli((op) => (op.path === 'vaults.open' ? opened.promise : undefined))
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/notes')
    store.set(openedRemoteAtom, 'syv-ai/notes')
    let flushStarted!: () => void
    const started = new Promise<void>((resolve) => {
      flushStarted = resolve
    })
    const unregister = registerBuffer(() => {
      flushStarted()
      return flush.promise
    })
    try {
      const moving = store.set(moveNotesAtom, { moves: [{ from: 'a.md', to: 'a.mdx' }] })
      await started
      const opening = store.set(openVaultAtom, 'other/repo')
      flush.resolve()
      await vi.waitFor(() =>
        expect(holi!.calls.some((call) => call.path === 'vaults.open')).toBe(true),
      )
      opened.resolve(emptySnapshot())
      await opening
      await moving

      expect(holi.calls.filter((call) => call.path === 'sync.commitNow')).toHaveLength(0)
      expect(holi.calls.filter((call) => call.path === 'notes.move')).toHaveLength(0)
    } finally {
      unregister()
    }
  })

  it('stops after an open completes during the restore-point commit', async () => {
    const commit = deferred<void>()
    const opened = deferred<VaultSnapshot>()
    let commitCount = 0
    holi = installFakeHoli((op) => {
      if (op.path === 'sync.commitNow' && ++commitCount === 1) return commit.promise
      if (op.path === 'vaults.open') return opened.promise
      return undefined
    })
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/notes')
    store.set(openedRemoteAtom, 'syv-ai/notes')
    const moving = store.set(moveNotesAtom, { moves: [{ from: 'a.md', to: 'a.mdx' }] })
    await vi.waitFor(() => expect(commitCount).toBe(1))

    const opening = store.set(openVaultAtom, 'other/repo')
    await vi.waitFor(() =>
      expect(holi!.calls.some((call) => call.path === 'vaults.open')).toBe(true),
    )
    opened.resolve(emptySnapshot())
    await opening
    commit.resolve()
    await moving

    expect(holi.calls.filter((call) => call.path === 'sync.commitNow')).toHaveLength(1)
    expect(holi.calls.filter((call) => call.path === 'notes.move')).toHaveLength(0)
  })

  it('does not commit the replacement vault when an open completes during the final snapshot', async () => {
    const snapshot = deferred<VaultSnapshot>()
    const opened = deferred<VaultSnapshot>()
    holi = installFakeHoli((op) => {
      if (op.path === 'vaults.snapshot') return snapshot.promise
      if (op.path === 'vaults.open') return opened.promise
      return undefined
    })
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/notes')
    store.set(openedRemoteAtom, 'syv-ai/notes')
    const moving = store.set(moveNotesAtom, { moves: [{ from: 'a.md', to: 'a.mdx' }] })
    await vi.waitFor(() =>
      expect(holi!.calls.some((call) => call.path === 'vaults.snapshot')).toBe(true),
    )

    const opening = store.set(openVaultAtom, 'other/repo')
    await vi.waitFor(() =>
      expect(holi!.calls.some((call) => call.path === 'vaults.open')).toBe(true),
    )
    opened.resolve(emptySnapshot())
    await opening
    snapshot.resolve(emptySnapshot())
    await moving

    expect(holi.calls.filter((call) => call.path === 'notes.move')).toHaveLength(1)
    expect(holi.calls.filter((call) => call.path === 'sync.commitNow')).toHaveLength(1)
    expect(holi.calls.filter((call) => call.path === 'vaults.snapshot')).toHaveLength(1)
  })

  it('does not move after an affected buffer fails to flush', async () => {
    holi = installFakeHoli()
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/notes')
    store.set(openedRemoteAtom, 'syv-ai/notes')
    const unregister = registerBuffer(() => Promise.reject(new Error('save failed')))
    try {
      await expect(
        store.set(moveNotesAtom, { moves: [{ from: 'notes/a.md', to: 'notes/a.mdx' }] }),
      ).rejects.toThrow('save failed')
      expect(holi.calls).toEqual([])
    } finally {
      unregister()
    }
  })

  it('does not retarget or refresh the replacement vault after an awaited move', async () => {
    let finishMove!: () => void
    let enteredMove!: () => void
    const pendingMove = new Promise<void>((resolve) => {
      finishMove = resolve
    })
    const moveStarted = new Promise<void>((resolve) => {
      enteredMove = resolve
    })
    holi = installFakeHoli((op) => {
      if (op.path === 'notes.move') {
        enteredMove()
        return pendingMove
      }
      if (op.path === 'vaults.snapshot') return emptySnapshot()
      return undefined
    })
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/notes')
    store.set(openedRemoteAtom, 'syv-ai/notes')
    store.set(openTabAtom, { kind: 'doc', path: 'notes/idea.md' })
    const pending = store.set(moveNotesAtom, {
      moves: [{ from: 'notes/idea.md', to: 'notes/idea.mdx' }],
      expectedRemote: 'syv-ai/notes',
    })
    await moveStarted
    store.set(activeRemoteAtom, 'other/repo')
    finishMove()
    await pending

    expect(holi.calls.filter((call) => call.path === 'notes.move')).toHaveLength(1)
    expect(holi.calls.filter((call) => call.path === 'vaults.snapshot')).toHaveLength(0)
    expect(holi.calls.filter((call) => call.path === 'sync.commitNow')).toHaveLength(1)
    expect(allTabs(store.get(workspaceOfAtom)('syv-ai/notes'))).toEqual(['notes/idea.md'])
    expect(allTabs(store.get(workspaceOfAtom)('other/repo'))).toEqual([])
  })

  it('is a no-op with no vault open, and with an empty batch', async () => {
    holi = installFakeHoli()
    const store = createStore()
    await store.set(moveNotesAtom, { moves: [{ from: 'a.md', to: 'b.md' }] })
    store.set(activeRemoteAtom, 'syv-ai/notes')
    await store.set(moveNotesAtom, { moves: [] })
    expect(holi.calls).toEqual([])
  })
})

describe('deleteManyAtom', () => {
  it('flushes, commits, deletes, commits', async () => {
    holi = installFakeHoli((op) => (op.path === 'vaults.snapshot' ? emptySnapshot() : undefined))
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/notes')

    await store.set(deleteManyAtom, { paths: ['a.md'] })

    expect(holi.calls.map((c) => c.path)).toEqual([
      'sync.commitNow',
      'notes.deleteMany',
      'vaults.snapshot',
      'sync.commitNow',
    ])
  })
})
