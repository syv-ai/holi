/**
 * The renderer half of rename.
 *
 * The property that matters is the *order*: flush the buffer, commit a clean
 * restore point, rename, then commit again — so the rename lands as one commit
 * on top of a state that is already safe. The open tab following the file is
 * the shell's, done by whoever asked for the rename (`onMoved`).
 */
import { createStore } from 'jotai'
import { afterEach, describe, expect, it } from 'vitest'
import type { VaultSnapshot } from '@holi/shared'
import { installFakeHoli, type FakeHoli } from '@/test/fake-holi'
import { registerBuffer } from '@/lib/buffer-registry'
import { activeRemoteAtom, renameNoteAtom } from '@/state/vaults'

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

describe('renameNoteAtom', () => {
  it('flushes, commits, renames, commits', async () => {
    holi = installFakeHoli((op) => {
      if (op.path === 'notes.rename') return { rewritten: [] }
      if (op.path === 'vaults.snapshot') return emptySnapshot()
      return undefined
    })
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/notes')

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
  })

  it('is a no-op with no vault open', async () => {
    holi = installFakeHoli()
    const store = createStore()

    await store.set(renameNoteAtom, { from: 'a.md', to: 'b.md' })

    expect(holi.calls).toEqual([])
  })
})
