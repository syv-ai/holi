import { Editor, Node } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { NodeSelection } from '@tiptap/pm/state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MultiCursor, extraSelections } from '../multi-cursor'

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

  it('clears multi-cursor selections on insert Escape before later edits', () => {
    const ed = new Editor({
      extensions: [
        StarterKit,
        MultiCursor,
        RichTextVim.configure({ enabled: false, editable: () => true }),
      ],
      content: '<p>word word</p>',
    })
    editor = ed
    configureRichTextVim(ed.view, true, true, () => true)
    ed.commands.setTextSelection(2)
    key(ed, 'd', { ctrlKey: true })
    key(ed, 'd', { ctrlKey: true })
    expect(extraSelections(ed.state)).toHaveLength(1)
    key(ed, 'i')
    key(ed, 'Escape')
    expect(extraSelections(ed.state)).toHaveLength(0)
    key(ed, 'Backspace')
    expect(text(ed)).toBe('word word')
  })

  it('treats marked text leaves as one grapheme and deletes selected inline atoms', () => {
    const ed = open('<p><strong>e</strong><em>́</em>x</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'x')
    expect(ed.getHTML()).toContain('x')
    expect(ed.getHTML()).not.toContain('́')

    const atom = Node.create({
      name: 'testAtom',
      inline: true,
      group: 'inline',
      atom: true,
      selectable: true,
      parseHTML: () => [{ tag: 'test-atom' }],
      renderHTML: () => ['test-atom'],
    })
    ed.destroy()
    editor = new Editor({
      extensions: [
        StarterKit,
        atom,
        RichTextVim.configure({ enabled: false, editable: () => true }),
      ],
      content: '<p>a<test-atom></test-atom>b</p>',
    })
    configureRichTextVim(editor.view, true, true, () => true)
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 2)))
    expect(editor.state.selection).toBeInstanceOf(NodeSelection)
    key(editor, 'x')
    expect(editor.getHTML()).not.toContain('test-atom')
    expect(text(editor)).toBe('ab')
  })

  it('advances word motions, targets the last grapheme with $, and navigates code-block lines', () => {
    const ed = open('<p>alpha beta</p><pre><code>one\ntwo\nthree</code></pre>')
    ed.commands.setTextSelection(1)
    key(ed, 'w')
    expect(ed.state.selection.head).toBe(7)
    key(ed, 'e')
    expect(ed.state.selection.head).toBe(10)
    ed.commands.setTextSelection(1)
    key(ed, '$')
    expect(ed.state.selection.head).toBe(10)
    key(ed, 'x')
    expect(text(ed)).toBe('alpha betone\ntwo\nthree')

    const codeStart = ed.state.doc.child(0).nodeSize + 1
    ed.commands.setTextSelection(codeStart + 1)
    key(ed, 'j')
    expect(ed.state.selection.$from.parent.textContent).toBe('one\ntwo\nthree')
    expect(ed.state.selection.head).toBe(codeStart + 5)
    key(ed, 'j')
    expect(ed.state.selection.head).toBe(codeStart + 9)
  })

  it('opens logical code-block lines in place and enters a prior block on its last line', () => {
    const ed = open('<pre><code>alpha\nbeta\ngamma</code></pre><p>end</p>')
    const codeStart = 1
    ed.commands.setTextSelection(codeStart + 6)
    key(ed, 'o')
    expect(ed.state.doc.firstChild?.type.name).toBe('codeBlock')
    expect(ed.state.doc.firstChild?.textContent).toBe('alpha\nbeta\n\ngamma')
    expect(ed.state.selection.$from.parent.type.name).toBe('codeBlock')
    key(ed, 'Escape')

    const finalParagraph = ed.state.doc.lastChild!
    ed.commands.setTextSelection(ed.state.doc.content.size - finalParagraph.nodeSize + 2)
    key(ed, 'k')
    expect(ed.state.selection.$from.parent.type.name).toBe('codeBlock')
    expect(ed.state.selection.$from.parentOffset).toBeGreaterThanOrEqual(12)
  })

  it('opens logical hard-break lines without splitting their paragraph', () => {
    const ed = open('<p>first<br>second</p>')
    ed.commands.setTextSelection(8)
    key(ed, 'o')
    expect(ed.state.doc.childCount).toBe(1)
    expect(ed.state.doc.firstChild?.childCount).toBe(4)
    expect(ed.state.selection.$from.parent.type.name).toBe('paragraph')
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
