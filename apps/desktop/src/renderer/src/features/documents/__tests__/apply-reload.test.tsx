/**
 * A change on disk comes into the editor as one edit over just the range that
 * differs, so a caret outside it stays on its text and ⌘Z only ever undoes
 * your own typing.
 */
import { Editor } from '@tiptap/react'
import { afterEach, expect, test } from 'vitest'

import { applyReload } from '../apply-reload'
import { createDocumentExtensions } from '../document-extensions'

let editor: Editor | null = null
afterEach(() => editor?.destroy())

function open(markdown: string): Editor {
  editor = new Editor({
    extensions: createDocumentExtensions({
      folder: 'notes',
      placeholder: '',
      onOpenLink: () => undefined,
    }),
    content: markdown,
    contentType: 'markdown',
  })
  return editor
}

/** Put the caret `offset` characters into the paragraph that reads `text`. */
function caretIn(ed: Editor, text: string, offset: number) {
  let at = -1
  ed.state.doc.descendants((node, pos) => {
    if (at === -1 && node.isTextblock && node.textContent === text) at = pos + 1 + offset
  })
  ed.commands.setTextSelection(at)
}

const where = (ed: Editor) => {
  const { $from } = ed.state.selection
  return { text: $from.parent.textContent, offset: $from.parentOffset }
}

test('a word added later in the same paragraph leaves the caret before it', () => {
  const ed = open('Alpha beta\n')
  caretIn(ed, 'Alpha beta', 2)
  applyReload(ed, 'Alpha beta gamma\n')
  expect(ed.getMarkdown()).toBe('Alpha beta gamma')
  expect(where(ed)).toEqual({ text: 'Alpha beta gamma', offset: 2 })
})

test('a block deleted above keeps the caret in its own paragraph', () => {
  const ed = open('One\n\nTwo\n\nThree\n')
  caretIn(ed, 'Three', 3)
  applyReload(ed, 'Two\n\nThree\n')
  expect(where(ed)).toEqual({ text: 'Three', offset: 3 })
})

test('the reload is not in the undo history', () => {
  const ed = open('Alpha\n')
  caretIn(ed, 'Alpha', 5)
  ed.commands.insertContent('!')
  applyReload(ed, 'Alpha!\n\nFrom a co-author\n')
  ed.commands.undo()
  expect(ed.getMarkdown()).toBe('Alpha\n\nFrom a co-author')
})

test('the same body is no transaction at all', () => {
  const ed = open('Alpha\n\nBeta\n')
  let transactions = 0
  ed.on('transaction', () => transactions++)
  applyReload(ed, 'Alpha\n\nBeta\n')
  expect(transactions).toBe(0)
})
