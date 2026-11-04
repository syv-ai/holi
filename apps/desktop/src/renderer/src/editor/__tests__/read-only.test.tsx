/**
 * A document the editor will not let you change (`features/vaults-sync.md`).
 *
 * Asserted by running a real editing command and watching it refuse, which is
 * the user-facing fact. The other half of the lock — `EditorView.editable`,
 * which takes the caret away so the document does not merely swallow input —
 * cannot be checked here: jsdom does not implement `contentEditable`, so it
 * belongs to hand-verification.
 */
import { insertNewlineAndIndent } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, expect, it } from 'vitest'
import { plainTextExtensions } from '../extensions'

let view: EditorView | null = null
afterEach(() => {
  view?.destroy()
  view = null
})

it('locks a plain file too — a conflicted config is the common case', () => {
  // `.holi/settings/app.yaml` and `.gitignore` conflict at least as often as prose,
  // and they open in the plain stack, which is a different set of extensions.
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  view = new EditorView({
    state: EditorState.create({
      doc: '{}\n',
      extensions: plainTextExtensions('.holi/settings/app.yaml', true),
    }),
    parent,
  })
  expect(insertNewlineAndIndent(view)).toBe(false)
  expect(view.state.doc.toString()).toBe('{}\n')
})
