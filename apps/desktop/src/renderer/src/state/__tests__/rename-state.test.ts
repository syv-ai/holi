/**
 * The renderer half of rename.
 *
 * The property that matters is the *order*: flush the buffer, commit a clean
 * restore point, rename, then commit again — so the rename lands as one commit
 * on top of a state that is already safe. The open tab following the file is
 * the shell's, done by whoever asked for the rename (`onMoved`).
 */
import { createElement } from 'react'
import { EditorView } from '@codemirror/view'
import { createStore, Provider } from 'jotai'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyVaultSnapshot, type VaultSnapshot } from '@holi/shared'
import { FileView } from '@/features/files/file-view'
import { installFakeHoli, type FakeHoli } from '@/test/fake-holi'
import { act, render, waitFor } from '@/test/render'
import { activeRemoteAtom, renameNoteAtom, moveNotesAtom, deleteManyAtom } from '@/state/vaults'
import { openTabAtom, shellWorkspaceAtom } from '@/state/shell-tabs'
import { allTabs } from '@/state/shell-workspace'

Range.prototype.getBoundingClientRect ??= () => new DOMRect()
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList

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
    store.set(openTabAtom, { kind: 'doc', path: 'old.txt' })
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
    expect(allTabs(store.get(shellWorkspaceAtom))).toEqual(['sub/new.txt'])
  })

  it.each(['rename', 'move', 'delete'] as const)(
    'blocks edits during %s without a ghost write',
    async (operation) => {
      let releaseCommit!: () => void
      let releaseMutation!: () => void
      let committing = false
      let mutating = false
      let commits = 0
      const commit = new Promise<void>((resolve) => {
        releaseCommit = resolve
      })
      const mutation = new Promise<void>((resolve) => {
        releaseMutation = resolve
      })
      holi = installFakeHoli((op) => {
        if (op.path === 'notes.read') return 'a\n'
        if (op.path === 'history.list' || op.path === 'github.fileContributors') return []
        if (op.path === 'sync.commitNow' && ++commits === 1) {
          committing = true
          return commit
        }
        if (['notes.rename', 'notes.move', 'notes.deleteMany'].includes(op.path)) {
          mutating = true
          return mutation
        }
        if (op.path === 'vaults.snapshot') return emptySnapshot()
        return undefined
      })
      const store = createStore()
      store.set(activeRemoteAtom, 'syv-ai/notes')
      const view = render(
        createElement(Provider, { store }, createElement(FileView, { path: 'old.txt' })),
      )
      const editor = await waitFor(() => {
        const node = document.querySelector<HTMLElement>('.cm-content')
        if (node === null) throw new Error('editor not ready')
        return EditorView.findFromDOM(node)!
      })
      const action =
        operation === 'rename'
          ? () => store.set(renameNoteAtom, { from: 'old.txt', to: 'new.txt' })
          : operation === 'move'
            ? () => store.set(moveNotesAtom, { moves: [{ from: 'old.txt', to: 'new.txt' }] })
            : () => store.set(deleteManyAtom, { paths: ['old.txt'] })
      const pending = action()
      try {
        await waitFor(() => expect(committing).toBe(true))
        act(() =>
          editor.dispatch({
            changes: { from: 0, to: editor.state.doc.length, insert: 'during commit\n' },
          }),
        )
        releaseCommit()
        await waitFor(() => expect(mutating).toBe(true))
        expect(editor.contentDOM).toHaveAttribute('contenteditable', 'false')
        act(() => editor.dispatch({ changes: { from: 0, insert: 'ghost' } }))
        expect(editor.state.doc.toString()).toBe('during commit\n')
        releaseMutation()
        await act(() => pending)
        view.unmount()
        await act(() => new Promise((resolve) => setTimeout(resolve, 700)))
        const writes = holi.calls.filter((op) => op.path === 'notes.write')
        expect(writes.map((op) => op.input)).toEqual([
          { remote: 'syv-ai/notes', path: 'old.txt', text: 'during commit\n' },
        ])
      } finally {
        releaseCommit()
        releaseMutation()
        await pending
        view.unmount()
      }
    },
  )

  it('is a no-op with no vault open', async () => {
    holi = installFakeHoli()
    const store = createStore()

    await store.set(renameNoteAtom, { from: 'a.md', to: 'b.md' })

    expect(holi.calls).toEqual([])
  })
})
