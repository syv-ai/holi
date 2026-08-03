/**
 * Apply a reload's text to the live buffer as a *co-author's* edit, not your own.
 *
 * Two things make this not-your-edit: the change is dispatched with
 * `addToHistory:false`, so ⌘Z never lands on foreign or stale text (CodeMirror
 * still remaps your own history through it, so your keystrokes stay undoable at
 * the right positions); and it is a `minimalChange` diff rather than a
 * whole-document replace, so CodeMirror's selection mapping carries the caret
 * through untouched. No `scrollIntoView`: a background reload must not move the
 * viewport. See `docs/specs/2026-08-03-undo-external-reload-design.md`.
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
