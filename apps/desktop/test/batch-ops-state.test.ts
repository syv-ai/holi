/**
 * The renderer half of the batch note ops. What matters is the ORDER — flush,
 * commit a clean restore point, run the batch, commit again — so a whole batch
 * lands as one commit-pair on safe ground, plus the open tabs following a move
 * and closing on a delete.
 */
import { createStore } from 'jotai'
import { afterEach, describe, expect, it } from 'vitest'
import type { VaultSnapshot } from '@holi/shared'
import { installFakeHoli, type FakeHoli } from './helpers/fake-holi'
import {
  activeRemoteAtom,
  copyNotesAtom,
  deleteManyAtom,
  moveNotesAtom,
} from '../src/renderer/src/state/vaults'
import { emptyWorkspace, openTab, workspaceAtom } from '../src/renderer/src/state/panes'

let holi: FakeHoli | null = null
afterEach(() => {
  holi?.restore()
  holi = null
})

const emptySnapshot = (): VaultSnapshot => ({ docs: [], tasks: [], broken: [] })

describe('moveNotesAtom', () => {
  it('flushes, commits, moves, commits — and retargets the open tabs', async () => {
    holi = installFakeHoli((op) => {
      if (op.path === 'notes.move') return { rewritten: [] }
      if (op.path === 'vaults.snapshot') return emptySnapshot()
      return undefined
    })
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/notes')
    store.set(workspaceAtom, openTab(emptyWorkspace(), { kind: 'note', path: 'projects/a.md' }))

    await store.set(moveNotesAtom, { moves: [{ from: 'projects/a.md', to: 'work/a.md' }] })

    expect(holi.calls.map((c) => c.path)).toEqual([
      'sync.commitNow',
      'notes.move',
      'vaults.snapshot',
      'sync.commitNow',
    ])
    expect(store.get(workspaceAtom).panes[0]!.tabs).toEqual([{ kind: 'note', path: 'work/a.md' }])
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
  it('flushes, commits, deletes, commits — and closes the deleted tabs', async () => {
    holi = installFakeHoli((op) => (op.path === 'vaults.snapshot' ? emptySnapshot() : undefined))
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/notes')
    store.set(workspaceAtom, openTab(emptyWorkspace(), { kind: 'note', path: 'a.md' }))

    await store.set(deleteManyAtom, { paths: ['a.md'] })

    expect(holi.calls.map((c) => c.path)).toEqual([
      'sync.commitNow',
      'notes.deleteMany',
      'vaults.snapshot',
      'sync.commitNow',
    ])
    expect(store.get(workspaceAtom).panes[0]!.tabs).toEqual([])
  })
})

describe('copyNotesAtom', () => {
  it('flushes, commits, copies, commits', async () => {
    holi = installFakeHoli((op) => {
      if (op.path === 'notes.copy') return { copied: ['a copy.md'] }
      if (op.path === 'vaults.snapshot') return emptySnapshot()
      return undefined
    })
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/notes')

    await store.set(copyNotesAtom, { copies: [{ from: 'a.md', to: 'a copy.md' }] })

    expect(holi.calls.map((c) => c.path)).toEqual([
      'sync.commitNow',
      'notes.copy',
      'vaults.snapshot',
      'sync.commitNow',
    ])
  })
})
