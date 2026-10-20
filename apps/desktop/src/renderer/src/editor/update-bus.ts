/**
 * React beside the editor (the page actions' Undo and Redo) hears about the
 * editor's updates here, without the pane re-rendering on every keystroke: a
 * listener sets state only when what it shows changes.
 */
import { EditorView, type ViewUpdate } from '@codemirror/view'

const listeners = new WeakMap<EditorView, Set<(update: ViewUpdate) => void>>()

/** Calls `fn` on each of the view's updates. Returns the unsubscribe. */
export function onEditorUpdate(view: EditorView, fn: (update: ViewUpdate) => void): () => void {
  let set = listeners.get(view)
  if (set === undefined) {
    set = new Set()
    listeners.set(view, set)
  }
  set.add(fn)
  return () => set.delete(fn)
}

export const updateBus = EditorView.updateListener.of((update) => {
  const set = listeners.get(update.view)
  if (set !== undefined) for (const fn of set) fn(update)
})
