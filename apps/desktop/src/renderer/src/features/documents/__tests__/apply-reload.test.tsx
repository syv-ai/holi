import { Editor } from '@tiptap/react'
import { afterEach, expect, test, vi } from 'vitest'

import { applyReload } from '../apply-reload'
import { createDocumentExtensions } from '../document-extensions'

const editors: Editor[] = []
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
})

function open(markdown: string): Editor {
  const editor = new Editor({
    extensions: createDocumentExtensions({
      folder: 'notes',
      placeholder: '',
      onOpenLink: () => undefined,
    }),
    content: markdown,
    contentType: 'markdown',
  })
  editors.push(editor)
  return editor
}

function caretIn(ed: Editor, text: string, offset: number) {
  let at = -1
  ed.state.doc.descendants((node, pos) => {
    if (at === -1 && node.isTextblock && node.textContent === text) at = pos + 1 + offset
  })
  if (at < 0) throw new Error(`No textblock found: ${text}`)
  ed.commands.setTextSelection(at)
}

const where = (ed: Editor) => {
  const { $from } = ed.state.selection
  return { text: $from.parent.textContent, offset: $from.parentOffset }
}

test('changes after the caret leave it on the same text', () => {
  const ed = open('Alpha beta\n')
  caretIn(ed, 'Alpha beta', 2)
  expect(applyReload(ed, 'Alpha beta gamma\n')).toBe(true)
  expect(ed.getMarkdown()).toBe('Alpha beta gamma')
  expect(where(ed)).toEqual({ text: 'Alpha beta gamma', offset: 2 })
})

test('deleting blocks above the caret maps it with its paragraph', () => {
  const ed = open('One\n\nTwo\n\nThree\n')
  caretIn(ed, 'Three', 3)
  applyReload(ed, 'Two\n\nThree\n')
  expect(where(ed)).toEqual({ text: 'Three', offset: 3 })
})

test('external edits do not enter undo history or trigger autosave updates', () => {
  const ed = open('Alpha\n')
  caretIn(ed, 'Alpha', 5)
  ed.commands.insertContent('!')
  const updates = vi.fn()
  ed.on('update', updates)
  applyReload(ed, 'Alpha!\n\nFrom a co-author\n')
  expect(updates).not.toHaveBeenCalled()
  ed.commands.undo()
  expect(ed.getMarkdown()).toBe('Alpha\n\nFrom a co-author')
})

test('an identical snapshot does not dispatch any transaction', () => {
  const ed = open('Alpha\n\nBeta\n')
  let transactions = 0
  ed.on('transaction', () => transactions++)
  expect(applyReload(ed, 'Alpha\n\nBeta\n')).toBe(false)
  expect(transactions).toBe(0)
})

test('overlapping changed ranges preserve the caret at the change start', () => {
  const ed = open('Alpha\n\nBeta\n')
  caretIn(ed, 'Alpha', 5)
  ed.commands.insertContent(' hello ')
  applyReload(ed, 'Alpha hello\n\nBeta gamma\n')
  expect(ed.getMarkdown()).toBe('Alpha hello\n\nBeta gamma')
  expect(where(ed)).toEqual({ text: 'Alpha hello', offset: 11 })
})

test('trailing lists do not cause a spurious edit and edits above map correctly', () => {
  const ed = open('One\n\nTwo\n\n- a\n- b\n')
  caretIn(ed, 'Two', 2)
  applyReload(ed, 'Two\n\n- a\n- b\n')
  expect(where(ed)).toEqual({ text: 'Two', offset: 2 })

  const unchanged = open('Alpha\n\n- a\n- b\n')
  // StarterKit adds its trailing paragraph on the first transaction.
  caretIn(unchanged, 'Alpha', 1)
  let transactions = 0
  unchanged.on('transaction', () => transactions++)
  expect(applyReload(unchanged, 'Alpha\n\n- a\n- b\n')).toBe(false)
  expect(transactions).toBe(0)
})

test('a selection stays a selection when its head is changed externally', () => {
  const ed = open('Alpha beta\n\nGamma\n')
  caretIn(ed, 'Alpha beta', 0)
  const from = ed.state.selection.from
  ed.commands.setTextSelection({ from, to: from + 8 })
  applyReload(ed, 'Alpha bxta\n\nGamma\n')
  expect(ed.state.selection.from).toBe(from)
  expect(ed.state.selection.to).toBeGreaterThan(from)
})

test('empty editor paragraphs absent from the file are retained to preserve position', () => {
  const ed = open('# Title\n\nIntro\n\nP2\n\nP3\n\nLast\n')
  caretIn(ed, 'Last', 4)
  ed.commands.enter()
  caretIn(ed, 'P3', 1)
  applyReload(ed, '# Title\n\nIntro edited\n\nP2\n\nP3\n\nLast\n')
  expect(where(ed)).toEqual({ text: 'P3', offset: 1 })
  expect(ed.state.doc.lastChild?.content.size).toBe(0)
})

test('dispatch errors propagate so callers cannot mark a failed reload as current', () => {
  const ed = open('Old text\n')
  const dispatch = vi.spyOn(ed.view, 'dispatch').mockImplementation(() => {
    throw new Error('dispatch failed')
  })
  expect(() => applyReload(ed, 'New text\n')).toThrow('dispatch failed')
  dispatch.mockRestore()
  expect(ed.getMarkdown()).toBe('Old text')
})
