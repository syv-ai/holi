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
