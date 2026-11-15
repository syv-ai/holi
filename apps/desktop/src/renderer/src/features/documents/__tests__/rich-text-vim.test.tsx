import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { configureRichTextVim, RichTextVim } from '../rich-text-vim'

let editor: Editor | null = null
afterEach(() => editor?.destroy())

function open(content: string, editable = true) {
  editor = new Editor({
    extensions: [
      StarterKit,
      RichTextVim.configure({ enabled: false, editable: () => editor?.isEditable ?? false }),
    ],
    content,
    editable,
  })
  configureRichTextVim(editor.view, true, true, () => editor?.isEditable ?? false)
  return editor
}

function key(ed: Editor, value: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', {
    key: value,
    bubbles: true,
    cancelable: true,
    ...options,
  })
  ed.view.dom.dispatchEvent(event)
  return event
}

const text = (ed: Editor) => ed.state.doc.textContent

describe('rich-text Vim extension', () => {
  it('routes real ProseMirror motions without document transactions and deletes one grapheme', () => {
    const ed = open('<p>café 👩‍💻</p>')
    ed.commands.setTextSelection(1)
    const before = ed.state.doc
    key(ed, 'l')
    expect(ed.state.selection.head).toBe(2)
    expect(ed.state.doc.eq(before)).toBe(true)
    expect(ed.view.dom.dataset.vimMode).toBe('normal')
    ed.commands.setTextSelection(1)
    key(ed, 'x')
    expect(text(ed)).toBe('afé 👩‍💻')
    expect(ed.getHTML()).toContain('afé 👩‍💻')
    ed.commands.setTextSelection(5)
    key(ed, 'x')
    expect(text(ed)).toBe('afé ')
  })

  it('enters insert mode, accepts native input, leaves at a normal-mode caret and uses ProseMirror history', () => {
    const ed = open('<p>word</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'i')
    expect(ed.view.dom.dataset.vimMode).toBe('insert')
    ed.view.dispatch(ed.state.tr.insertText('X'))
    expect(text(ed)).toBe('Xword')
    key(ed, 'Escape')
    expect(ed.view.dom.dataset.vimMode).toBe('normal')
    expect(ed.state.selection.head).toBe(1)
    key(ed, 'u')
    expect(text(ed)).toBe('word')
    key(ed, 'r', { ctrlKey: true })
    expect(text(ed)).toBe('Xword')
  })

  it('supports logical lines and makes no editing changes while read-only', () => {
    const ed = open('<p>one</p><p>two</p>')
    ed.commands.setTextSelection(2)
    key(ed, 'j')
    expect(ed.state.selection.$from.parent.textContent).toBe('two')
    ed.setEditable(false)
    key(ed, 'x')
    expect(text(ed)).toBe('onetwo')
    ed.setEditable(true)
    key(ed, 'o')
    expect(ed.state.doc.childCount).toBe(3)
    expect(ed.state.selection.$from.parent.textContent).toBe('')
    expect(ed.view.dom.dataset.vimMode).toBe('insert')
  })

  it('opens a blank logical line above with O', () => {
    const ed = open('<p>one</p><p>two</p>')
    ed.commands.setTextSelection(6)
    key(ed, 'O')
    expect(ed.state.doc.childCount).toBe(3)
    expect(ed.state.selection.$from.parent.textContent).toBe('')
    expect(ed.view.dom.dataset.vimMode).toBe('insert')
  })

  it('keeps composition and modified shortcuts out of Vim routing and requests hints for normal f', () => {
    const onHints = vi.fn()
    const ed = new Editor({
      extensions: [
        StarterKit,
        RichTextVim.configure({ enabled: false, editable: () => true, onHints }),
      ],
      content: '<p>word</p>',
    })
    editor = ed
    configureRichTextVim(ed.view, true, true, () => true)
    const composition = key(ed, 'x', { isComposing: true })
    expect(composition.defaultPrevented).toBe(false)
    key(ed, 'b', { ctrlKey: true })
    expect(ed.isActive('bold')).toBe(true)
    key(ed, 'f')
    expect(onHints).toHaveBeenCalledWith(ed.view)
    expect(text(ed)).toBe('word')
  })
})
