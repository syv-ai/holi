import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { describe, expect, it } from 'vitest'

import { applyReload } from '../apply-reload'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', toDOM: () => ['p', 0], parseDOM: [{ tag: 'p' }] },
    text: {},
  },
})

function paragraph(text: string) {
  return schema.node('paragraph', null, text ? schema.text(text) : undefined)
}

function state(...paragraphs: string[]) {
  return EditorState.create({
    schema,
    doc: schema.node('doc', null, paragraphs.map(paragraph)),
  })
}

describe('applyReload', () => {
  it('inserts and deletes before a selection while mapping its position', () => {
    const initial = state('keep', 'selected')
    const selection = TextSelection.create(initial.doc, 6, 14)
    const selected = initial.apply(initial.tr.setSelection(selection))
    const inserted = applyReload(selected, state('new', 'keep', 'selected').doc)!
    const afterInsert = selected.apply(inserted)

    expect(afterInsert.doc.textContent).toBe('newkeptselected')
    expect(afterInsert.doc.textBetween(afterInsert.selection.from, afterInsert.selection.to)).toBe('selected')

    const deleted = applyReload(afterInsert, state('selected').doc)!
    const afterDelete = afterInsert.apply(deleted)
    expect(afterDelete.doc.textContent).toBe('selected')
    expect(afterDelete.doc.textBetween(afterDelete.selection.from, afterDelete.selection.to)).toBe('selected')
  })

  it('replaces changes inside the selected text without emitting an undo step', () => {
    const current = state('before local after')
    const selected = current.apply(current.tr.setSelection(TextSelection.create(current.doc, 8, 13)))
    const transaction = applyReload(selected, state('before disk after').doc)!
    const next = selected.apply(transaction)

    expect(next.doc.textContent).toBe('before disk after')
    expect(transaction.getMeta('addToHistory')).toBe(false)
    expect(next.selection.from).toBeLessThanOrEqual(next.selection.to)
  })

  it('returns no transaction for identical documents and handles a trailing empty paragraph', () => {
    expect(applyReload(state('same'), state('same').doc)).toBeNull()

    const current = state('line')
    const transaction = applyReload(current, state('line', '').doc)!
    expect(current.apply(transaction).doc.childCount).toBe(2)
  })
})
