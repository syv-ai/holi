/**
 * The renderer half of rename (FR-11).
 *
 * The property that matters is the *order*: flush the buffer, commit a clean
 * restore point, rename, then commit again — so the rename lands as one commit
 * on top of a state that is already safe. And the open tab has to follow the
 * file to its new path, or it points at something that no longer exists.
 */
import { createStore } from 'jotai'
import { afterEach, describe, expect, it } from 'vitest'
import type { VaultSnapshot } from '@holi/shared'
import { installFakeHoli, type FakeHoli } from './helpers/fake-holi'
import { registerBuffer } from '../src/renderer/src/lib/buffer-registry'
import { activeRemoteAtom, renameNoteAtom } from '../src/renderer/src/state/vaults'
import { emptyWorkspace, openTab, workspaceAtom } from '../src/renderer/src/state/panes'

let holi: FakeHoli | null = null
afterEach(() => {
  holi?.restore()
  holi = null
})

const emptySnapshot = (): VaultSnapshot => ({ docs: [], tasks: [], broken: [] })

describe('renameNoteAtom', () => {
  it('flushes, commits, renames, commits — and retargets the open tab', async () => {
    holi = installFakeHoli((op) => {
      if (op.path === 'notes.rename') return { rewritten: [] }
      if (op.path === 'vaults.snapshot') return emptySnapshot()
      return undefined
    })
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/notes')
    store.set(workspaceAtom, openTab(emptyWorkspace(), { kind: 'note', path: 'old.md' }))

    let flushed = false
    const unregister = registerBuffer(async () => {
      flushed = true
    })

    await store.set(renameNoteAtom, { from: 'old.md', to: 'sub/new.md' })
    unregister()

    expect(flushed).toBe(true)
    expect(holi.calls.map((c) => c.path)).toEqual([
      'sync.commitNow',
      'notes.rename',
      'vaults.snapshot',
      'sync.commitNow',
    ])
    expect(store.get(workspaceAtom).panes[0]!.tabs).toEqual([{ kind: 'note', path: 'sub/new.md' }])
  })

  it('is a no-op with no vault open', async () => {
    holi = installFakeHoli()
    const store = createStore()

    await store.set(renameNoteAtom, { from: 'a.md', to: 'b.md' })

    expect(holi.calls).toEqual([])
  })
})
