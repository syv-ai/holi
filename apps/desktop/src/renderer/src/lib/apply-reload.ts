/**
 * Apply a reload's text to the live buffer as a *co-author's* edit, not your own.
 *
 * `addToHistory:false`, so ⌘Z never lands on foreign text (your own history is
 * still remapped through it); a `minimalChange` diff rather than a whole
 * replace, so selection mapping keeps the caret. No `scrollIntoView`: a
 * background reload must not move the viewport. See `docs/features/editor.md`.
 */
import { Transaction } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { minimalChange } from './editor-reload'

export function applyReload(view: EditorView, text: string): void {
  const change = minimalChange(view.state.doc.toString(), text)
  if (change === null) return
  view.dispatch({
    changes: change,
    annotations: [Transaction.addToHistory.of(false)],
  })
}
