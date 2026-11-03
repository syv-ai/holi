/**
 * The renderer half of rename.
 *
 * The property that matters is the *order*: flush the buffer, commit a clean
 * restore point, rename, then commit again — so the rename lands as one commit
 * on top of a state that is already safe. And the open tab has to follow the
 * file to its new path, or it points at something that no longer exists.
 */
import { createElement } from 'react'
import { EditorView } from '@codemirror/view'
import { createStore, Provider } from 'jotai'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyVaultSnapshot, type VaultSnapshot } from '@holi/shared'
import { FileView } from '@/features/files/file-view'
import { installFakeHoli, type FakeHoli } from '@/test/fake-holi'
import { act, render, waitFor } from '@/test/render'
import { activeRemoteAtom, renameNoteAtom } from '@/state/vaults'
import { emptyWorkspace, openTab, workspaceAtom } from '@/state/panes'

let holi: FakeHoli | null = null
afterEach(() => {
  holi?.restore()
  holi = null
})

const emptySnapshot = (): VaultSnapshot => emptyVaultSnapshot()

describe('renameNoteAtom', () => {
  it('flushes the open editor, commits, renames, commits — and retargets the open tab', async () => {
    holi = installFakeHoli((op) => {
      if (op.path === 'notes.read') return 'a\n'
      if (op.path === 'history.list' || op.path === 'github.fileContributors') return []
      if (op.path === 'notes.rename') return { rewritten: [] }
      if (op.path === 'vaults.snapshot') return emptySnapshot()
      return undefined
    })
    const store = createStore()
    store.set(activeRemoteAtom, 'syv-ai/notes')
    store.set(workspaceAtom, openTab(emptyWorkspace(), { kind: 'note', path: 'old.txt' }))
    const at = (path: string) =>
      createElement(Provider, { store }, createElement(FileView, { path }))
    const view = render(at('old.txt'))

    // An edit still inside the save delay when the rename starts.
    const content = await waitFor(() => {
      const node = document.querySelector<HTMLElement>('.cm-content')
      if (node === null) throw new Error('no editor yet')
      return node
    })
    const editor = EditorView.findFromDOM(content)!
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'b\n' } })

    await act(() => store.set(renameNoteAtom, { from: 'old.txt', to: 'sub/new.txt' }))
    // The tab follows the file, and the editor on the old path goes.
    view.rerender(at('sub/new.txt'))
    await act(() => new Promise((resolve) => setTimeout(resolve, 800)))
    view.unmount()

    const ops = holi.calls
      .filter((c) => !['notes.read', 'history.list', 'github.fileContributors'].includes(c.path))
      .map((c) => c.path)
    expect(ops).toEqual([
      'notes.write',
      'sync.commitNow',
      'notes.rename',
      'vaults.snapshot',
      'sync.commitNow',
    ])
    expect(holi.calls.find((c) => c.path === 'notes.write')!.input).toEqual({
      remote: 'syv-ai/notes',
      path: 'old.txt',
      text: 'b\n',
    })
    expect(store.get(workspaceAtom).panes[0]!.tabs).toEqual([{ kind: 'note', path: 'sub/new.txt' }])
  })

  it('is a no-op with no vault open', async () => {
    holi = installFakeHoli()
    const store = createStore()

    await store.set(renameNoteAtom, { from: 'a.md', to: 'b.md' })

    expect(holi.calls).toEqual([])
  })
})
