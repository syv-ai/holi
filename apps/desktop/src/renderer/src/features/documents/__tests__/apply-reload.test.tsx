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

test('a caret inside the replaced range stays at its start, not past it', () => {
  const ed = open('Alpha\n\nBeta\n')
  caretIn(ed, 'Alpha', 5)
  ed.commands.insertContent(' hello ')
  // The tidy took the trailing space off the file and a word arrived below,
  // so the replaced range runs from that space into the last paragraph.
  applyReload(ed, 'Alpha hello\n\nBeta gamma\n')
  expect(ed.getMarkdown()).toBe('Alpha hello\n\nBeta gamma')
  expect(where(ed)).toEqual({ text: 'Alpha hello', offset: 11 })
})

test('in a document ending in a list, a block deleted above keeps the caret', () => {
  const ed = open('One\n\nTwo\n\n- a\n- b\n')
  caretIn(ed, 'Two', 2)
  applyReload(ed, 'Two\n\n- a\n- b\n')
  expect(where(ed)).toEqual({ text: 'Two', offset: 2 })
})

test('the same body ending in a list is no transaction at all', () => {
  const ed = open('Alpha\n\n- a\n- b\n')
  // Any transaction lets the trailing-node rule add its empty paragraph.
  caretIn(ed, 'Alpha', 1)
  let transactions = 0
  ed.on('transaction', () => transactions++)
  applyReload(ed, 'Alpha\n\n- a\n- b\n')
  expect(transactions).toBe(0)
})

test('a selection whose head is in the changed range stays a selection', () => {
  const ed = open('Alpha beta\n\nGamma\n')
  caretIn(ed, 'Alpha beta', 0)
  const from = ed.state.selection.from
  ed.commands.setTextSelection({ from, to: from + 8 })
  applyReload(ed, 'Alpha bxta\n\nGamma\n')
  expect(ed.state.selection.from).toBe(from)
  expect(ed.state.selection.to).toBeGreaterThan(from)
})

test('an empty paragraph the file cannot hold keeps an edit above off the caret', () => {
  const ed = open('# Title\n\nIntro\n\nP2\n\nP3\n\nLast\n')
  caretIn(ed, 'Last', 4)
  ed.commands.enter()
  caretIn(ed, 'P3', 1)
  // The tidy collapses the file's final newlines, so the empty paragraph
  // Enter left at the end is in the buffer only.
  applyReload(ed, '# Title\n\nIntro edited\n\nP2\n\nP3\n\nLast\n')
  expect(where(ed)).toEqual({ text: 'P3', offset: 1 })
  expect(ed.state.doc.lastChild?.content.size).toBe(0)
})
