import { history, undo } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { applyReload } from './apply-reload'

let view: EditorView

beforeEach(() => {
  view = new EditorView({
    state: EditorState.create({ doc: 'hello', extensions: [history()] }),
    parent: document.body,
  })
})

afterEach(() => view.destroy())

function userType(at: number, insert: string): void {
  // A normal edit: goes into history (addToHistory defaults to true).
  view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length } })
}

test('a foreign insertion before the caret keeps the caret on the same character', () => {
  userType(5, '!') // "hello!" caret at 6
  applyReload(view, 'TOP\nhello!') // foreign prepend of 4 chars
  expect(view.state.doc.toString()).toBe('TOP\nhello!')
  // Caret was at 6, the insert added 4 chars before it -> 10, still just after '!'.
  expect(view.state.selection.main.head).toBe(10)
})

test('undo unwinds your edit and leaves the foreign text; the reload is not an undo step', () => {
  userType(5, '!') // your edit, in history
  applyReload(view, 'TOP\nhello!') // foreign edit, NOT in history
  undo(view)
  // One undo removed your '!' and skipped the reload entirely: the foreign
  // "TOP\n" survives, proving the reload never became a discrete undo step.
  expect(view.state.doc.toString()).toBe('TOP\nhello')
})

test('an identical reload is a no-op', () => {
  applyReload(view, 'hello')
  expect(view.state.doc.toString()).toBe('hello')
})
