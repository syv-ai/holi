/**
 * The renderer half of the batch note ops. What matters is the ORDER — flush,
 * commit a clean restore point, run the batch, commit again — so a whole batch
 * lands as one commit-pair on safe ground. The open tabs following a move and
 * closing on a delete are the shell's, done by the caller (the file tree).
 */
import { createStore } from 'jotai'
import { afterEach, describe, expect, it } from 'vitest'
import type { VaultSnapshot } from '@holi/shared'
import { installFakeHoli, type FakeHoli } from '@/test/fake-holi'
import { activeRemoteAtom, deleteManyAtom, moveNotesAtom } from '@/state/vaults'
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

describe('moveNotesAtom', () => {
  it('flushes, commits, moves, commits', async () => {
    holi = installFakeHoli((op) => {
      if (op.path === 'notes.move') return { rewritten: [] }
      if (op.path === 'vaults.snapshot') return emptySnapshot()
      return undefined
    })
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/notes')

    await store.set(moveNotesAtom, { moves: [{ from: 'projects/a.md', to: 'work/a.md' }] })

    expect(holi.calls.map((c) => c.path)).toEqual([
      'sync.commitNow',
      'notes.move',
      'vaults.snapshot',
      'sync.commitNow',
    ])
  })

  it('does not move after an affected buffer fails to flush', async () => {
    holi = installFakeHoli()
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/notes')
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
