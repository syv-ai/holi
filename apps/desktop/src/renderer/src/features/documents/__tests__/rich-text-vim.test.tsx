import { Editor, Node } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MultiCursor, extraSelections } from '../multi-cursor'

import { configureRichTextVim, RichTextVim } from '../rich-text-vim'
import { WikiLink } from '../wiki-link'
import { TaskList } from '@tiptap/extension-list'
import { RichTextTaskItem } from '../rich-text/rich-text-task-item'

let editor: Editor | null = null
const editors = new Set<Editor>()
afterEach(() => {
  for (const ed of editors) ed.destroy()
  editors.clear()
  editor = null
})

function own(ed: Editor) {
  editor = ed
  editors.add(ed)
  return ed
}

function open(content: string, editable = true, onFeedback?: (message: string) => void) {
  editor = new Editor({
    extensions: [
      StarterKit,
      RichTextVim.configure({
        enabled: false,
        editable: () => editor?.isEditable ?? false,
        onFeedback,
      }),
    ],
    content,
    editable,
  })
  own(editor)
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

function openTable(onFeedback?: (message: string) => void) {
  editor = new Editor({
    extensions: [
      StarterKit,
      TableKit,
      RichTextVim.configure({
        enabled: false,
        editable: () => editor?.isEditable ?? false,
        onFeedback,
      }),
    ],
    content:
      '<table><tbody><tr><td><p>one</p></td></tr><tr><td><p>last</p></td></tr></tbody></table>',
  })
  own(editor)
  configureRichTextVim(editor.view, true, true, () => editor?.isEditable ?? false)
  let lastCellPos = 0
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'tableCell') lastCellPos = pos
  })
  editor.commands.setTextSelection(lastCellPos + 2)
  return editor
}

describe('rich-text Vim extension', () => {
  it('cancels pending Vim commands before an Escape-owned overlay', () => {
    const onEscapeOwned = vi.fn()
    editor = new Editor({
      extensions: [
        StarterKit,
        RichTextVim.configure({
          enabled: false,
          editable: () => editor?.isEditable ?? false,
          escapeOwned: () => true,
          onEscapeOwned,
        }),
      ],
      content: '<p>alpha beta</p>',
    })
    const ed = own(editor)
    configureRichTextVim(ed.view, true, true, () => ed.isEditable)

    key(ed, 'd')
    expect(key(ed, 'Escape').defaultPrevented).toBe(true)
    expect(onEscapeOwned).not.toHaveBeenCalled()
    key(ed, 'w')
    expect(text(ed)).toBe('alpha beta')

    expect(key(ed, 'Escape').defaultPrevented).toBe(true)
    expect(onEscapeOwned).toHaveBeenCalledOnce()
    expect(text(ed)).toBe('alpha beta')
  })

  it('applies exact operator and logical-line ranges', () => {
    const ed = open('<p>abcd</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'd')
    key(ed, 'l')
    expect(text(ed)).toBe('bcd')

    ed.commands.setContent('<p>one two three</p>')
    ed.commands.setTextSelection(1)
    key(ed, '2')
    key(ed, 'c')
    key(ed, 'w')
    ed.view.dispatch(ed.state.tr.insertText('X'))
    expect(text(ed)).toBe('X three')
    key(ed, 'Escape')

    ed.commands.setContent('<p>first<br>second</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'c')
    key(ed, 'c')
    ed.view.dispatch(ed.state.tr.insertText('X'))
    expect(ed.getHTML()).toBe('<p>X<br>second</p>')
    key(ed, 'Escape')

    ed.commands.setContent('<p>keep<br>delete</p><p>next</p>')
    const feedback = vi.fn()
    const unsupported = open('<p>keep<br>delete</p><p>next</p>', true, feedback)
    unsupported.commands.setTextSelection(6)
    key(unsupported, '2')
    key(unsupported, 'V')
    key(unsupported, 'd')
    expect(unsupported.getHTML()).toBe('<p>keep<br>delete</p><p>next</p>')
    expect(feedback).toHaveBeenCalled()
  })
  it('completes counted word operators through terminal words and logical line breaks', () => {
    const ed = open('<p>one two three</p>')
    ed.commands.setTextSelection(1)
    key(ed, '2')
    key(ed, 'c')
    key(ed, 'w')
    ed.view.dispatch(ed.state.tr.insertText('X'))
    expect(ed.getHTML()).toBe('<p>X three</p>')
    key(ed, 'Escape')

    ed.commands.setContent('<p>one two</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'd')
    key(ed, '2')
    key(ed, 'w')
    expect(ed.getHTML()).toBe('<p></p>')

    ed.commands.setContent('<p>first</p><p>second</p><p>third</p>')
    ed.commands.setTextSelection(1)
    key(ed, '2')
    key(ed, 'c')
    key(ed, 'c')
    ed.view.dispatch(ed.state.tr.insertText('X'))
    expect(ed.getHTML()).toBe('<p>X</p><p>third</p>')
    key(ed, 'Escape')

    ed.commands.setContent('<p>first<br>second<br>third</p>')
    ed.commands.setTextSelection(1)
    key(ed, '2')
    key(ed, 'c')
    key(ed, 'c')
    ed.view.dispatch(ed.state.tr.insertText('X'))
    expect(ed.getHTML()).toBe('<p>X<br>third</p>')
    key(ed, 'Escape')

    ed.commands.setContent('<pre><code>one\ntwo</code></pre>')
    ed.commands.setTextSelection(1)
    key(ed, 'd')
    key(ed, '2')
    key(ed, 'w')
    expect(ed.state.doc.firstChild?.textContent).toBe('')

    ed.commands.setContent('<p>A👩‍💻éB</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'd')
    key(ed, 'l')
    expect(ed.getHTML()).toBe('<p>👩‍💻éB</p>')
  })

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

  it('runs counted operators, visual selections, and structured yank/paste on ProseMirror', () => {
    const ed = open('<p><strong>alpha</strong> beta</p><p>gamma</p>')
    ed.commands.setTextSelection(1)
    key(ed, '2')
    key(ed, 'd')
    key(ed, 'w')
    expect(text(ed)).toBe('gamma')
    key(ed, 'u')
    expect(text(ed)).toBe('alpha betagamma')

    ed.commands.setTextSelection(1)
    key(ed, 'y')
    key(ed, 'w')
    key(ed, 'P')
    expect(ed.getHTML()).toBe(
      '<p><strong>alpha</strong> <strong>alpha</strong> beta</p><p>gamma</p>',
    )
    expect(ed.state.doc.toJSON()).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', marks: [{ type: 'bold' }], text: 'alpha' },
            { type: 'text', text: ' ' },
            { type: 'text', marks: [{ type: 'bold' }], text: 'alpha' },
            { type: 'text', text: ' beta' },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'gamma' }] },
      ],
    })

    ed.commands.setTextSelection(1)
    key(ed, 'v')
    key(ed, 'l')
    expect(ed.state.selection.empty).toBe(false)
    key(ed, 'd')
    expect(ed.state.selection.empty).toBe(true)
  })

  it('yanks and deletes a whole logical line with doubled operators', () => {
    const ed = open('<p>first</p><p>second</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'd')
    key(ed, 'd')
    expect(text(ed)).toBe('second')
    key(ed, 'P')
    expect(text(ed)).toBe('firstsecond')
  })

  it('consumes unsupported normal-mode editing keys without document transactions', () => {
    const ed = open('<p>word</p>')
    const before = ed.state.doc
    let docChanges = 0
    ed.on('transaction', ({ transaction }) => {
      if (transaction.docChanged) docChanges += 1
    })

    for (const [value, options] of [
      ['Enter', {}],
      ['Enter', { shiftKey: true }],
      ['Backspace', {}],
      ['Delete', {}],
    ] as const) {
      const event = key(ed, value, options)
      expect(event.defaultPrevented).toBe(true)
      expect(ed.state.doc.eq(before)).toBe(true)
    }
    expect(docChanges).toBe(0)

    ed.commands.setContent('<p>one</p><p>two</p>')
    ed.commands.setTextSelection(7)
    key(ed, 'g')
    key(ed, 'Enter')
    key(ed, 'g')
    expect(ed.state.selection.head).toBe(7)
    key(ed, 'g')
    expect(ed.state.selection.head).toBe(1)
  })

  it('consumes Tab navigation in normal mode without changing a table document', () => {
    const ed = openTable()
    const before = ed.state.doc
    let docChanges = 0
    ed.on('transaction', ({ transaction }) => {
      if (transaction.docChanged) docChanges += 1
    })

    for (const options of [{}, { shiftKey: true }]) {
      const event = key(ed, 'Tab', options)
      expect(event.defaultPrevented).toBe(true)
      expect(ed.state.doc.eq(before)).toBe(true)
    }
    expect(docChanges).toBe(0)
    expect(ed.state.doc.firstChild?.childCount).toBe(2)
  })

  it('resolves vertical ranges inside a cell before rejecting cross-cell motion', () => {
    const ed = openTable()
    ed.commands.setContent(
      '<table><tbody><tr><td><p>a<br>b</p></td><td><p>other</p></td></tr></tbody></table>',
    )
    let firstText = 0
    ed.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'a') firstText = pos
    })
    ed.commands.setTextSelection(firstText)
    key(ed, 'd')
    key(ed, 'j')
    const cells: string[] = []
    ed.state.doc.descendants((node) => {
      if (node.type.name === 'tableCell') cells.push(node.textContent)
    })
    expect(cells).toEqual(['', 'other'])
    expect(ed.state.doc.check()).toBeUndefined()
  })

  it('keeps native table Tab behavior in insert and off modes', () => {
    const insert = openTable()
    key(insert, 'i')
    key(insert, 'Tab')
    expect(insert.state.doc.firstChild?.childCount).toBe(3)

    const off = openTable()
    configureRichTextVim(off.view, false, true, () => true)
    key(off, 'Tab')
    expect(off.state.doc.firstChild?.childCount).toBe(3)
  })

  it('keeps native Enter and deletion editing in insert and off modes', () => {
    const insert = open('<p>word</p>')
    key(insert, 'i')
    insert.commands.setTextSelection(2)
    key(insert, 'Enter')
    expect(insert.state.doc.childCount).toBe(2)

    const off = open('<p>word</p>')
    configureRichTextVim(off.view, false, true, () => true)
    off.commands.setTextSelection(2)
    key(off, 'Enter')
    expect(off.state.doc.childCount).toBe(2)
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
    own(ed)
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
    own(editor)
    configureRichTextVim(editor.view, true, true, () => true)
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 2)))
    expect(editor.state.selection).toBeInstanceOf(NodeSelection)
    key(editor, 'x')
    expect(editor.getHTML()).not.toContain('test-atom')
    expect(text(editor)).toBe('ab')
  })

  it('keeps repeated x on a valid normal-mode grapheme and atom position at line end', () => {
    const ed = open('<p>alpha beta gamma</p>')
    ed.commands.setTextSelection(16)
    key(ed, '$')
    expect(ed.state.selection.head).toBe(16)
    key(ed, 'x')
    expect(text(ed)).toBe('alpha beta gamm')
    expect(ed.state.selection.head).toBe(15)
    key(ed, 'x')
    expect(text(ed)).toBe('alpha beta gam')
  })

  it('moves across graphemes spanning marks and classifies unicode word characters', () => {
    const ed = open('<p><strong>e</strong><em>́clair</em> next, stop!</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'w')
    expect(ed.state.selection.head).toBe(9)
    key(ed, 'b')
    expect(ed.state.selection.head).toBe(1)
    key(ed, 'e')
    expect(ed.state.selection.head).toBe(7)
    key(ed, 'w')
    expect(ed.state.selection.head).toBe(9)
    key(ed, 'w')
    expect(ed.state.selection.head).toBe(15)
    key(ed, 'b')
    expect(ed.state.selection.head).toBe(9)

    const atom = Node.create({
      name: 'wordAtom',
      inline: true,
      group: 'inline',
      atom: true,
      selectable: true,
      parseHTML: () => [{ tag: 'word-atom' }],
      renderHTML: () => ['word-atom'],
    })
    ed.destroy()
    editor = new Editor({
      extensions: [StarterKit, atom, RichTextVim.configure({ enabled: false })],
      content: '<p>one<word-atom></word-atom>two, three</p>',
    })
    own(editor)
    configureRichTextVim(editor.view, true, true, () => true)
    editor.commands.setTextSelection(1)
    key(editor, 'w')
    expect(editor.state.selection.head).toBe(5)
    key(editor, 'w')
    expect(editor.state.selection.head).toBe(10)
  })

  it('anchors forward word motions at empty blocks and document endpoints', () => {
    const ed = open('<p>alpha</p><p></p><p>beta</p>')
    const emptyParagraphPos = ed.state.doc.child(0).nodeSize + 1
    ed.commands.setTextSelection(emptyParagraphPos)
    key(ed, 'w')
    expect(ed.state.selection.head).toBe(emptyParagraphPos + 2)
    key(ed, 'e')
    expect(ed.state.selection.head).toBe(emptyParagraphPos + 5)

    ed.commands.setTextSelection(1)
    key(ed, 'w')
    expect(ed.state.selection.head).toBe(emptyParagraphPos + 2)
    ed.commands.setTextSelection(1)
    key(ed, 'e')
    expect(ed.state.selection.head).toBe(5)
    ed.commands.setTextSelection(ed.state.doc.content.size - 1)
    const end = ed.state.selection.head
    key(ed, 'w')
    expect(ed.state.selection.head).toBe(end)
    key(ed, 'e')
    expect(ed.state.selection.head).toBe(end)
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

  it('uses operator-prefix counts as products and keeps pending counts independent', () => {
    const ed = open('<p>one two three four five six seven eight</p>')
    ed.commands.setTextSelection(1)
    for (const keyName of ['2', 'd', '3', 'w']) key(ed, keyName)
    expect(text(ed)).toBe('seven eight')

    ed.commands.setContent('<p>alpha beta gamma</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'd')
    key(ed, 'w')
    expect(text(ed)).toBe('beta gamma')
    ed.commands.setTextSelection(1)
    key(ed, 'd')
    key(ed, 'e')
    expect(text(ed)).toBe(' gamma')
  })

  it('makes visual mode a real inclusive grapheme selection and cancels it on Escape', () => {
    const ed = open('<p>a👩‍💻bc</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'v')
    key(ed, 'l')
    expect(ed.state.selection.empty).toBe(false)
    key(ed, 'Escape')
    expect(ed.state.selection.empty).toBe(true)
    expect(ed.view.dom.dataset.vimMode).toBe('normal')
    expect(text(ed)).toBe('a👩‍💻bc')
  })

  it('selects visual graphemes inclusively in both directions and handles counted V', () => {
    const ed = open('<p>a👩‍💻bc</p><p>second</p><p>third</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'v')
    key(ed, 'l')
    expect(ed.state.doc.textBetween(ed.state.selection.from, ed.state.selection.to)).toBe('a👩‍💻')
    key(ed, 'l')
    expect(ed.state.doc.textBetween(ed.state.selection.from, ed.state.selection.to)).toBe('a👩‍💻b')
    key(ed, 'Escape')
    ed.commands.setTextSelection(7)
    key(ed, 'v')
    key(ed, 'h')
    expect(ed.state.doc.textBetween(ed.state.selection.from, ed.state.selection.to)).toBe('👩‍💻b')
    key(ed, 'Escape')

    ed.commands.setTextSelection(1)
    key(ed, '2')
    key(ed, 'V')
    key(ed, 'd')
    expect(text(ed)).toBe('third')
  })

  it('maps pending operators through inserts, cancels invalidated or externally moved selections', () => {
    const ed = open('<p>alpha beta</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'd')
    ed.view.dispatch(ed.state.tr.insertText('X', 1))
    key(ed, 'w')
    expect(text(ed)).toBe('Xbeta')

    ed.commands.setContent('<p>alpha beta</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'd')
    ed.view.dispatch(ed.state.tr.setSelection(TextSelection.near(ed.state.doc.resolve(3))))
    const before = text(ed)
    key(ed, 'w')
    expect(text(ed)).toBe(before)
  })

  it('keeps d, de, db and zero motions grapheme-safe and guards cross-cell edits', () => {
    const ed = open('<p>one two three</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'd')
    key(ed, 'w')
    expect(text(ed)).toBe('two three')
    ed.commands.setContent('<p>one two three</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'd')
    key(ed, 'e')
    expect(text(ed)).toBe(' two three')
    ed.commands.setContent('<p>one two three</p>')
    ed.commands.setTextSelection(5)
    key(ed, 'd')
    key(ed, 'b')
    expect(text(ed)).toBe('two three')
    ed.commands.setContent('<p>one two three</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'd')
    key(ed, '$')
    expect(text(ed)).toBe('')
  })

  it('groups change and inserted text into one undo and clears occurrence selections before Vim edits', () => {
    const ed = open('<p>word word</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'c')
    key(ed, 'w')
    ed.view.dispatch(ed.state.tr.insertText('X'))
    key(ed, 'Escape')
    key(ed, 'u')
    expect(text(ed)).toBe('word word')

    const multi = new Editor({
      extensions: [
        StarterKit,
        MultiCursor,
        RichTextVim.configure({ enabled: false, editable: () => true }),
      ],
      content: '<p>word word</p>',
    })
    own(multi)
    configureRichTextVim(multi.view, true, true, () => true)
    multi.commands.setTextSelection(1)
    key(multi, 'd', { ctrlKey: true })
    key(multi, 'd', { ctrlKey: true })
    expect(extraSelections(multi.state)).toHaveLength(1)
    key(multi, 'x')
    expect(extraSelections(multi.state)).toHaveLength(0)
  })

  it('rejects real cross-cell operator and visual destinations before ProseMirror clamps them', () => {
    for (const sequence of [
      ['d', 'j'],
      ['d', 'w'],
      ['d', 'k'],
      ['d', '2', 'j'],
      ['2', 'd', 'd'],
      ['V', 'j', 'd'],
    ]) {
      const feedback = vi.fn()
      const table = openTable(feedback)
      let firstCellPos = 0
      table.state.doc.descendants((node, pos) => {
        if (node.type.name === 'tableCell' && !firstCellPos) firstCellPos = pos
      })
      table.commands.setTextSelection(firstCellPos + 2)
      const before = table.state.doc
      for (const value of sequence) key(table, value)
      expect(table.state.doc.eq(before), sequence.join('')).toBe(true)
      if (sequence.join('') === 'dj' || sequence.join('') === 'dw' || sequence.join('') === 'Vjd')
        expect(feedback).toHaveBeenCalled()
      expect(table.state.doc.firstChild?.type.name).toBe('table')
    }

    const onVisualFeedback = vi.fn()
    const visualTable = openTable(onVisualFeedback)
    let visualCellPos = 0
    visualTable.state.doc.descendants((node, pos) => {
      if (node.type.name === 'tableCell' && !visualCellPos) visualCellPos = pos
    })
    visualTable.commands.setTextSelection(visualCellPos + 2)
    const beforeVisualMotion = visualTable.state.doc
    key(visualTable, 'v')
    key(visualTable, 'w')
    expect(visualTable.state.doc.eq(beforeVisualMotion)).toBe(true)
    expect(visualTable.state.selection.empty).toBe(true)
    expect(onVisualFeedback).toHaveBeenCalled()

    const countedVisual = openTable(onVisualFeedback)
    let countedCellPos = 0
    countedVisual.state.doc.descendants((node, pos) => {
      if (node.type.name === 'tableCell' && !countedCellPos) countedCellPos = pos
    })
    countedVisual.commands.setTextSelection(countedCellPos + 2)
    const beforeCountedVisual = countedVisual.state.doc
    key(countedVisual, '2')
    key(countedVisual, 'V')
    expect(countedVisual.state.doc.eq(beforeCountedVisual)).toBe(true)
    expect(countedVisual.state.selection.empty).toBe(true)
    expect(onVisualFeedback).toHaveBeenCalled()

    const table = openTable()
    let firstCellPos = 0
    table.state.doc.descendants((node, pos) => {
      if (node.type.name === 'tableCell' && !firstCellPos) firstCellPos = pos
    })
    table.commands.setTextSelection(firstCellPos + 2)
    key(table, 'c')
    key(table, 'c')
    expect(table.view.dom.dataset.vimMode).toBe('insert')
    expect(table.state.doc.firstChild?.check()).toBeUndefined()
    expect(table.state.doc.firstChild?.firstChild?.firstChild?.firstChild?.type.name).toBe(
      'paragraph',
    )
  })

  it('allows same-cell block edits and preserves an empty cell paragraph', () => {
    const table = openTable()
    table.commands.setContent(
      '<table><tbody><tr><td><p>first</p><p>second</p></td></tr></tbody></table>',
    )
    let firstCellPos = 0
    table.state.doc.descendants((node, pos) => {
      if (node.type.name === 'tableCell' && !firstCellPos) firstCellPos = pos
    })
    table.commands.setTextSelection(firstCellPos + 2)
    key(table, 'y')
    key(table, 'y')
    key(table, 'p')
    const pastedCell = table.state.doc.firstChild?.firstChild?.firstChild
    expect(pastedCell?.childCount).toBe(3)
    expect(pastedCell?.content.toJSON()).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'second' }] },
    ])
    expect(table.state.doc.check()).toBeUndefined()

    table.commands.setContent(
      '<table><tbody><tr><td><p>first</p><p>second</p></td></tr><tr><td><p>other</p></td></tr></tbody></table>',
    )
    firstCellPos = 0
    table.state.doc.descendants((node, pos) => {
      if (node.type.name === 'tableCell' && !firstCellPos) firstCellPos = pos
    })
    table.commands.setTextSelection(firstCellPos + 2)
    key(table, 'd')
    key(table, 'j')
    expect(table.state.doc.textContent).toBe('other')
    expect(table.state.doc.firstChild?.check()).toBeUndefined()

    table.commands.setContent('<table><tbody><tr><td><p></p></td></tr></tbody></table>')
    firstCellPos = 0
    table.state.doc.descendants((node, pos) => {
      if (node.type.name === 'tableCell' && !firstCellPos) firstCellPos = pos
    })
    table.commands.setTextSelection(firstCellPos + 1)
    key(table, 'd')
    key(table, 'd')
    expect(table.state.doc.firstChild?.check()).toBeUndefined()
    expect(table.state.doc.firstChild?.firstChild?.firstChild?.firstChild?.type.name).toBe(
      'paragraph',
    )
  })

  it('preserves list and table containers for doubled line deletion', () => {
    const ed = open('<ul><li><p>first</p></li><li><p>second</p></li></ul>')
    ed.commands.setTextSelection(3)
    key(ed, 'd')
    key(ed, 'd')
    expect(ed.state.doc.firstChild?.type.name).toBe('bulletList')
    expect(ed.state.doc.firstChild?.childCount).toBe(1)
    expect(text(ed)).toBe('second')

    const table = openTable()
    key(table, 'd')
    key(table, 'd')
    expect(table.state.doc.firstChild?.type.name).toBe('table')
    expect(table.state.doc.firstChild?.childCount).toBe(2)
  })

  it('keeps an existing rich Slice register intact across a yank and paste', () => {
    const ed = open('<p><strong>alpha</strong> [[target]]</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'y')
    key(ed, 'w')
    ed.commands.setTextSelection(ed.state.doc.content.size - 1)
    key(ed, 'p')
    expect(ed.getHTML()).toContain('<strong>alpha</strong>')
  })

  it('uses the displayed visual range once and resets counted commands', () => {
    const ed = open('<p>abcd efgh ijklmnop</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'v')
    key(ed, 'l')
    key(ed, 'd')
    expect(text(ed)).toBe('cd efgh ijklmnop')

    ed.commands.setContent('<p>abcd efgh ijklmnop</p>')
    ed.commands.setTextSelection(5)
    key(ed, 'v')
    key(ed, 'h')
    key(ed, 'd')
    expect(text(ed)).toBe('abcefgh ijklmnop')

    ed.commands.setContent('<p>one two three four five six seven eight nine ten eleven</p>')
    ed.commands.setTextSelection(1)
    for (const value of ['d', '1', '0', 'w']) key(ed, value)
    expect(text(ed)).toBe('eleven')

    ed.commands.setContent('<p>one two three</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'd')
    key(ed, '3')
    key(ed, 'd')
    expect(text(ed)).toBe('')

    ed.commands.setContent('<p>abcd</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'v')
    key(ed, '2')
    key(ed, 'l')
    key(ed, 'd')
    expect(text(ed)).toBe('d')
  })

  it('keeps yank carets stable, clears transient input on blur and isolates undo groups', () => {
    const ed = open('<p>one two three</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'y')
    key(ed, 'w')
    expect(ed.state.selection.head).toBe(1)
    key(ed, 'P')
    expect(text(ed)).toBe('one one two three')
    key(ed, 'u')
    expect(text(ed)).toBe('one two three')

    ed.commands.setTextSelection(1)
    key(ed, 'd')
    ed.view.dom.dispatchEvent(new Event('blur'))
    key(ed, 'w')
    expect(text(ed)).toBe('one two three')

    key(ed, 'd')
    ed.view.dom.dispatchEvent(new Event('compositionstart'))
    key(ed, 'w')
    expect(text(ed)).toBe('one two three')

    key(ed, 'd')
    ed.view.dom.dispatchEvent(new Event('compositionend'))
    key(ed, 'w')
    expect(text(ed)).toBe('one two three')

    key(ed, 'd')
    configureRichTextVim(ed.view, true, true, () => ed.isEditable)
    key(ed, 'w')
    expect(text(ed)).toBe('one two three')

    ed.commands.setTextSelection(1)
    key(ed, 'v')
    key(ed, 'l')
    key(ed, 'y')
    expect(ed.state.selection.empty).toBe(true)
    expect(ed.state.selection.head).toBe(1)

    const history = open('<p>one two three</p>')
    history.commands.setTextSelection(1)
    key(history, 'd')
    key(history, 'w')
    history.view.dispatch(history.state.tr.insertText('X').setTime(Date.now() + 10_000))
    key(history, 'u')
    expect(text(history)).toBe('two three')
    key(history, 'u')
    expect(text(history)).toBe('one two three')
  })

  it('repeats counted structured puts and keeps a change insert session in native history', () => {
    const ed = open('<p><strong>alpha</strong> beta</p><p>tail</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'y')
    key(ed, 'w')
    ed.commands.setTextSelection(7)
    key(ed, '2')
    key(ed, 'P')
    expect(ed.state.doc.toJSON()).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', marks: [{ type: 'bold' }], text: 'alpha' },
            { type: 'text', text: ' ' },
            { type: 'text', marks: [{ type: 'bold' }], text: 'alpha' },
            { type: 'text', text: ' ' },
            { type: 'text', marks: [{ type: 'bold' }], text: 'alpha' },
            { type: 'text', text: ' beta' },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'tail' }] },
      ],
    })
    key(ed, 'u')
    expect(ed.state.doc.toJSON()).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', marks: [{ type: 'bold' }], text: 'alpha' },
            { type: 'text', text: ' beta' },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'tail' }] },
      ],
    })

    ed.commands.setContent('<p>one two</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'c')
    key(ed, 'w')
    ed.view.dispatch(ed.state.tr.insertText('A').setTime(Date.now() + 10_000))
    ed.view.dispatch(ed.state.tr.insertText('B').setTime(Date.now() + 20_000))
    key(ed, 'Escape')
    expect(ed.state.doc.toJSON()).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'AB two' }],
        },
      ],
    })
    key(ed, 'u')
    expect(ed.state.doc.toJSON()).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one two' }] }],
    })
    key(ed, 'r', { ctrlKey: true })
    expect(ed.state.doc.textContent).toBe('AB two')

    key(ed, 'i')
    ed.view.dispatch(ed.state.tr.insertText('C'))
    key(ed, 'Escape')
    key(ed, 'u')
    expect(ed.state.doc.textContent).toBe('AB two')
    key(ed, 'u')
    expect(ed.state.doc.textContent).toBe('one two')
  })

  it('preserves grapheme boundaries and operator-specific final-word ranges', () => {
    const ed = open('<p>A👩‍💻B</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'd')
    key(ed, '$')
    expect(text(ed)).toBe('')
    expect(ed.state.doc.firstChild?.textContent).toBe('')

    ed.commands.setContent('<p>alpha</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'd')
    key(ed, 'w')
    expect(text(ed)).toBe('')

    ed.commands.setContent('<p>alpha beta</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'c')
    key(ed, 'w')
    expect(text(ed)).toBe(' beta')
    expect(ed.view.dom.dataset.vimMode).toBe('insert')
  })

  it('yanks, changes and deletes logical lines inside code blocks without flattening the block', () => {
    const ed = open('<pre><code>first\nmiddle\nlast</code></pre>')
    ed.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'typescript' },
          content: [{ type: 'text', text: 'first\nmiddle\nlast' }],
        },
      ],
    })
    ed.commands.setTextSelection(8)
    key(ed, 'd')
    key(ed, 'd')
    expect(ed.state.doc.toJSON()).toEqual({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'typescript' },
          content: [{ type: 'text', text: 'first\nlast' }],
        },
        { type: 'paragraph' },
      ],
    })
    expect(ed.state.doc.check()).toBeUndefined()

    ed.commands.setContent('<pre><code>first\nmiddle\nlast</code></pre>')
    ed.commands.setTextSelection(8)
    key(ed, 'y')
    key(ed, 'y')
    ed.commands.setTextSelection(2)
    key(ed, 'p')
    expect(ed.state.doc.firstChild?.type.name).toBe('codeBlock')
    expect(ed.state.doc.firstChild?.textContent).toBe('first\nmiddle\nmiddle\nlast')
    expect(ed.state.doc.check()).toBeUndefined()

    ed.commands.setTextSelection(8)
    key(ed, 'c')
    key(ed, 'c')
    expect(ed.state.doc.firstChild?.type.name).toBe('codeBlock')
    expect(ed.state.doc.firstChild?.textContent).toBe('first\n\nmiddle\nlast')
    expect(ed.view.dom.dataset.vimMode).toBe('insert')
    key(ed, 'Escape')

    ed.commands.setContent('<p>first<br>middle<br>last</p>')
    ed.commands.setTextSelection(8)
    key(ed, 'd')
    key(ed, 'd')
    expect(ed.state.doc.firstChild?.toJSON()).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'first' },
        { type: 'hardBreak' },
        { type: 'text', text: 'last' },
      ],
    })
    expect(ed.state.doc.check()).toBeUndefined()

    ed.commands.setContent('<p>first<br>second</p>')
    ed.commands.setTextSelection(2)
    key(ed, 'd')
    key(ed, 'd')
    expect(ed.state.doc.firstChild?.toJSON()).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'second' }],
    })

    key(ed, 'Escape')
    ed.commands.setContent('<pre><code>first\nmiddle\nlast</code></pre>')
    ed.commands.setTextSelection(2)
    key(ed, '2')
    key(ed, 'V')
    key(ed, 'y')
    ed.commands.setTextSelection(ed.state.doc.firstChild!.nodeSize - 2)
    key(ed, 'p')
    expect(ed.state.doc.firstChild?.textContent).toBe('first\nmiddle\nlast\nfirst\nmiddle')
    expect(ed.state.doc.firstChild?.type.name).toBe('codeBlock')
    expect(ed.state.doc.check()).toBeUndefined()

    ed.commands.setContent('<pre><code>first\nmiddle\nlast</code></pre>')
    ed.commands.setTextSelection(2)
    key(ed, 'd')
    key(ed, 'j')
    expect(ed.state.doc.firstChild?.textContent).toBe('last')
    expect(ed.state.doc.firstChild?.type.name).toBe('codeBlock')
    expect(ed.state.doc.check()).toBeUndefined()

    ed.commands.setContent('<p>first<br>middle<br>last</p>')
    ed.commands.setTextSelection(8)
    key(ed, 'y')
    key(ed, 'y')
    ed.commands.setTextSelection(2)
    key(ed, 'p')
    expect(ed.state.doc.firstChild?.toJSON()).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'first' },
        { type: 'hardBreak' },
        { type: 'text', text: 'middle' },
        { type: 'hardBreak' },
        { type: 'text', text: 'middle' },
        { type: 'hardBreak' },
        { type: 'text', text: 'last' },
      ],
    })

    ed.commands.setContent('<p>first<br>middle<br>last</p>')
    ed.commands.setTextSelection(2)
    key(ed, 'd')
    key(ed, 'j')
    expect(ed.state.doc.firstChild?.toJSON()).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'last' }],
    })
    expect(ed.state.doc.check()).toBeUndefined()
  })

  it('pastes listwise registers as sibling list items', () => {
    const ed = open('<ul><li><p>first</p></li><li><p>second</p></li></ul>')
    let firstText = 0
    ed.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'first') firstText = pos
    })
    ed.commands.setTextSelection(firstText)
    key(ed, 'y')
    key(ed, 'y')
    key(ed, 'p')
    expect(ed.state.doc.firstChild?.type.name).toBe('bulletList')
    expect(ed.state.doc.firstChild?.childCount).toBe(3)
    expect(ed.state.doc.firstChild?.content.toJSON()).toEqual([
      {
        type: 'listItem',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }],
      },
      {
        type: 'listItem',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }],
      },
      {
        type: 'listItem',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }],
      },
    ])
    expect(ed.state.doc.check()).toBeUndefined()

    ed.commands.setContent('<p>first</p><p>second</p><p>third</p>')
    ed.commands.setTextSelection(9)
    key(ed, 'y')
    key(ed, 'y')
    key(ed, 'P')
    expect(ed.state.doc.toJSON()).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'second' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'second' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'third' }] },
      ],
    })
  })

  it('copies real wiki-link atoms and task-item attributes through linewise registers', () => {
    const wiki = new Editor({
      extensions: [
        StarterKit,
        WikiLink.configure({ onOpen: () => undefined }),
        RichTextVim.configure({ enabled: false, editable: () => true }),
      ],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'first ' },
              { type: 'wikiLink', attrs: { target: 'folder/note', label: 'Note' } },
            ],
          },
        ],
      },
    })
    own(wiki)
    configureRichTextVim(wiki.view, true, true, () => true)
    wiki.commands.setTextSelection(2)
    key(wiki, 'y')
    key(wiki, 'y')
    wiki.commands.setTextSelection(wiki.state.doc.content.size - 1)
    key(wiki, 'p')
    const links: { name: string; attrs: Record<string, unknown> }[] = []
    wiki.state.doc.descendants((node) => {
      if (node.type.name === 'wikiLink') links.push({ name: node.type.name, attrs: node.attrs })
    })
    expect(links).toEqual([
      { name: 'wikiLink', attrs: { target: 'folder/note', label: 'Note' } },
      { name: 'wikiLink', attrs: { target: 'folder/note', label: 'Note' } },
    ])
    expect(wiki.state.doc.check()).toBeUndefined()

    const tasks = new Editor({
      extensions: [
        StarterKit,
        TaskList,
        RichTextTaskItem.configure({ nested: true }),
        RichTextVim.configure({ enabled: false, editable: () => true }),
      ],
      content:
        '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>done</p></li><li data-type="taskItem" data-checked="false"><p>todo</p></li></ul>',
    })
    own(tasks)
    configureRichTextVim(tasks.view, true, true, () => true)
    let doneText = 0
    tasks.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'done') doneText = pos
    })
    tasks.commands.setTextSelection(doneText)
    key(tasks, 'y')
    key(tasks, 'y')
    key(tasks, 'p')
    expect(tasks.state.doc.firstChild?.childCount).toBe(3)
    expect(
      Array.from(
        { length: 3 },
        (_, index) => tasks.state.doc.firstChild?.child(index).attrs.checked,
      ),
    ).toEqual([true, true, false])
    expect(tasks.state.doc.firstChild?.child(1).textContent).toBe('done')
    expect(tasks.state.doc.check()).toBeUndefined()
  })

  it('deletes, changes and restores complete checked task items', () => {
    const ed = new Editor({
      extensions: [
        StarterKit,
        TaskList,
        RichTextTaskItem.configure({ nested: true }),
        RichTextVim.configure({ enabled: false, editable: () => true }),
      ],
      content:
        '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>done</p><ul><li><p>nested</p></li></ul></li><li data-type="taskItem" data-checked="false"><p>next</p></li></ul>',
    })
    own(ed)
    configureRichTextVim(ed.view, true, true, () => true)
    let done = 0
    ed.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'done') done = pos
    })
    ed.commands.setTextSelection(done)
    key(ed, 'd')
    key(ed, 'd')
    expect(ed.state.doc.firstChild?.childCount).toBe(1)
    expect(ed.state.doc.firstChild?.child(0).attrs.checked).toBe(false)
    expect(ed.state.doc.textContent).toBe('next')
    key(ed, 'P')
    expect(ed.state.doc.firstChild?.childCount).toBe(2)
    expect(ed.state.doc.firstChild?.child(0).attrs.checked).toBe(true)
    expect(ed.state.doc.firstChild?.child(0).textContent).toBe('donenested')
    let restoredText = 0
    ed.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'done') restoredText = pos
    })
    ed.commands.setTextSelection(restoredText)
    key(ed, 'c')
    key(ed, 'c')
    expect(ed.state.doc.firstChild?.child(0).attrs.checked).toBe(true)
    expect(ed.state.doc.firstChild?.child(0).firstChild?.textContent).toBe('')
    expect(ed.state.doc.firstChild?.child(0).child(1).textContent).toBe('nested')
    expect(ed.state.doc.check()).toBeUndefined()
    key(ed, 'Escape')

    ed.commands.setContent(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>done</p><ul><li><p>nested</p></li></ul></li><li data-type="taskItem" data-checked="false"><p>next</p></li></ul>',
    )
    ed.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'done') restoredText = pos
    })
    ed.commands.setTextSelection(restoredText)
    key(ed, 'V')
    key(ed, 'd')
    expect(ed.state.doc.firstChild?.childCount).toBe(1)
    expect(ed.state.doc.firstChild?.child(0).textContent).toBe('next')
    expect(ed.state.doc.check()).toBeUndefined()
    key(ed, 'P')
    expect(ed.state.doc.firstChild?.childCount).toBe(2)
    expect(ed.state.doc.firstChild?.child(0).attrs.checked).toBe(true)
    expect(ed.state.doc.firstChild?.child(0).textContent).toBe('donenested')
    expect(ed.state.doc.check()).toBeUndefined()
  })

  it('uses the nearest table cell rather than an enclosing list item', () => {
    for (const sequence of [
      ['d', 'd'],
      ['V', 'd'],
    ]) {
      const ed = new Editor({
        extensions: [
          StarterKit,
          TableKit,
          RichTextVim.configure({ enabled: false, editable: () => true }),
        ],
        content:
          '<ul><li><p>outer</p><table><tbody><tr><td><p>cell</p></td><td><p>other</p></td></tr></tbody></table><p>tail</p></li><li><p>sibling</p></li></ul>',
      })
      own(ed)
      configureRichTextVim(ed.view, true, true, () => true)
      let cell = 0
      ed.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === 'cell') cell = pos
      })
      ed.commands.setTextSelection(cell)
      for (const value of sequence) key(ed, value)
      expect(ed.state.doc.textContent).toContain('outer')
      expect(ed.state.doc.textContent).toContain('sibling')
      expect(ed.state.doc.textContent).toContain('other')
      expect(ed.state.doc.textContent).toContain('tail')
      expect(ed.state.doc.check()).toBeUndefined()
    }
  })

  it('preserves heading schema on cc and linewise intent for vertical operators', () => {
    const ed = open('<h2>Heading</h2><p>next</p>')
    ed.commands.setTextSelection(2)
    key(ed, 'c')
    key(ed, 'c')
    expect(ed.state.doc.firstChild?.type.name).toBe('heading')
    expect(ed.state.doc.firstChild?.attrs.level).toBe(2)
    expect(ed.state.doc.childCount).toBe(2)
    key(ed, 'Escape')

    ed.commands.setContent('<p>first</p><p>second</p><p>third</p>')
    ed.commands.setTextSelection(2)
    key(ed, 'y')
    key(ed, 'j')
    ed.commands.setTextSelection(ed.state.doc.content.size - 1)
    key(ed, 'p')
    expect(ed.state.doc.childCount).toBe(5)
    expect(ed.state.doc.toJSON()).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'second' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'third' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'second' }] },
      ],
    })
    expect(ed.state.doc.check()).toBeUndefined()
  })

  it('changes only selected logical-line content and groups the change with delayed typing', () => {
    for (const [html, expected] of [
      ['<pre><code>first\nmiddle\nlast</code></pre>', 'first\nX\nlast'],
      ['<p>first<br>middle<br>last</p>', '<p>first<br>X<br>last</p>'],
    ] as const) {
      const ed = open(html)
      const initial = ed.state.doc.toJSON()
      let middle = html.startsWith('<pre>') ? 7 : 0
      ed.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === 'middle') middle = pos
      })
      ed.commands.setTextSelection(middle)
      key(ed, 'c')
      key(ed, 'c')
      expect(ed.view.dom.dataset.vimMode).toBe('insert')
      ed.view.dispatch(ed.state.tr.insertText('X'))
      expect(html.startsWith('<p>') ? ed.getHTML() : text(ed)).toBe(expected)
      key(ed, 'Escape')
      key(ed, 'u')
      expect(ed.state.doc.toJSON()).toEqual(initial)
    }

    const ed = open('<p>first</p><p>middle</p><p>last</p>')
    ed.commands.setTextSelection(8)
    key(ed, 'c')
    key(ed, 'c')
    ed.view.dispatch(ed.state.tr.insertText('X'))
    expect(ed.getHTML()).toBe('<p>first</p><p>X</p><p>last</p>')
    key(ed, 'Escape')
    key(ed, 'u')
    expect(ed.getHTML()).toBe('<p>first</p><p>middle</p><p>last</p>')
  })

  it('changes first, middle and last logical lines with counts one and two', () => {
    const cases = [
      { index: 0, count: 1, code: 'X\nmiddle\nlast', hardBreak: 'X<br>middle<br>last' },
      { index: 1, count: 1, code: 'first\nX\nlast', hardBreak: 'first<br>X<br>last' },
      { index: 2, count: 1, code: 'first\nmiddle\nX', hardBreak: 'first<br>middle<br>X' },
      { index: 0, count: 2, code: 'X\nlast', hardBreak: 'X<br>last' },
      { index: 1, count: 2, code: 'first\nX', hardBreak: 'first<br>X' },
      { index: 2, count: 2, code: 'first\nmiddle\nX', hardBreak: 'first<br>middle<br>X' },
    ] as const
    for (const { index, count, code, hardBreak } of cases) {
      for (const schema of ['code', 'hardBreak'] as const) {
        const html =
          schema === 'code'
            ? '<pre><code>first\nmiddle\nlast</code></pre>'
            : '<p>first<br>middle<br>last</p>'
        const ed = open(html)
        ed.commands.setTextSelection([1, 7, 14][index]!)
        if (count > 1) key(ed, String(count))
        key(ed, 'c')
        key(ed, 'c')
        ed.view.dispatch(ed.state.tr.insertText('X'))
        expect(
          schema === 'code' ? ed.state.doc.firstChild?.textContent : ed.getHTML().slice(3, -4),
        ).toBe(schema === 'code' ? code : hardBreak)
      }
    }
  })

  it('changes linewise block selections and vertical motions to a replacement block', () => {
    for (const [html, start, sequence, expected] of [
      ['<p>first</p><p>middle</p><p>last</p>', 1, ['V', 'c'], '<p>X</p><p>middle</p><p>last</p>'],
      ['<p>first</p><p>middle</p><p>last</p>', 1, ['c', 'j'], '<p>X</p><p>last</p>'],
      ['<p>first</p><p>middle</p><p>last</p>', 8, ['c', 'k'], '<p>X</p><p>last</p>'],
      ['<p>first</p><p>middle</p><p>last</p>', 16, ['V', 'c'], '<p>first</p><p>middle</p><p>X</p>'],
      ['<p>first<br>middle<br>last</p>', 1, ['V', 'c'], '<p>X<br>middle<br>last</p>'],
      // StarterKit's trailingNode keeps an editable paragraph after a final code block.
      [
        '<pre><code>first\nmiddle\nlast</code></pre><p></p>',
        1,
        ['c', 'j'],
        '<pre><code>X\nlast</code></pre><p></p>',
      ],
      [
        '<pre><code>first\nmiddle\nlast</code></pre><p></p>',
        7,
        ['c', 'k'],
        '<pre><code>X\nlast</code></pre><p></p>',
      ],
    ] as const) {
      const ed = open(html)
      ed.commands.setTextSelection(start)
      for (const value of sequence) key(ed, value)
      ed.view.dispatch(ed.state.tr.insertText('X').setTime(Date.now() + 10_000))
      expect(ed.getHTML(), `${html} :: ${sequence.join('')}`).toBe(expected)
      expect(ed.state.doc.check()).toBeUndefined()
      key(ed, 'Escape')
      key(ed, 'u')
      expect(ed.getHTML(), `${html} :: ${sequence.join('')} undo`).toBe(html)
      key(ed, 'r', { ctrlKey: true })
      expect(ed.getHTML(), `${html} :: ${sequence.join('')} redo`).toBe(expected)
    }
  })

  it('repeats linewise register content with logical separators', () => {
    for (const count of [2, 3]) {
      const code = open('<pre><code>first</code></pre>')
      code.commands.setTextSelection(1)
      key(code, 'y')
      key(code, 'y')
      key(code, String(count))
      key(code, 'p')
      expect(code.state.doc.firstChild?.textContent).toBe(
        Array.from({ length: count + 1 }, () => 'first').join('\n'),
      )
      expect(code.state.doc.check()).toBeUndefined()

      const hardBreak = open('<p>first<br>second</p>')
      hardBreak.commands.setTextSelection(1)
      key(hardBreak, 'y')
      key(hardBreak, 'y')
      key(hardBreak, String(count))
      key(hardBreak, 'p')
      expect(hardBreak.getHTML()).toContain(`<p>first${'<br>first'.repeat(count)}<br>second</p>`)
      expect(hardBreak.state.doc.check()).toBeUndefined()
    }

    const paragraphs = open('<p>first</p><p>second</p>')
    paragraphs.commands.setTextSelection(1)
    key(paragraphs, 'y')
    key(paragraphs, 'y')
    key(paragraphs, '2')
    key(paragraphs, 'p')
    expect(paragraphs.state.doc.childCount).toBe(4)
    expect(paragraphs.state.doc.check()).toBeUndefined()
  })

  it('uses visual numeric prefixes and the destination line for inclusive e', () => {
    const ed = open('<pre><code>one\ntwo</code></pre>')
    ed.commands.setTextSelection(1)
    key(ed, 'd')
    key(ed, '2')
    key(ed, 'e')
    expect(ed.state.doc.firstChild?.textContent).toBe('')

    ed.commands.setContent('<p>one<br>two</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'd')
    key(ed, '2')
    key(ed, 'e')
    expect(ed.state.doc.firstChild?.textContent).toBe('')

    ed.commands.setContent('<p>one two three</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'v')
    key(ed, '1')
    key(ed, '0')
    key(ed, 'l')
    expect(ed.state.doc.textBetween(ed.state.selection.from, ed.state.selection.to)).toBe(
      'one two thr',
    )
    key(ed, 'd')
    expect(text(ed)).toBe('ee')

    ed.commands.setContent('<p>A👩‍💻éB</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'd')
    key(ed, '2')
    key(ed, 'e')
    expect(text(ed)).toBe('')

    ed.commands.setContent('<p>first</p><p>middle</p><p>last</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'V')
    key(ed, '1')
    key(ed, '0')
    key(ed, 'j')
    expect(ed.state.selection.empty).toBe(false)
    key(ed, 'd')
    expect(ed.getHTML()).toBe('<p></p>')
  })

  it('cancels pending count and prefix after an external selection without changing internal motions', () => {
    const ed = open('<p>one</p><p>two</p><p>three</p>')
    ed.commands.setTextSelection(1)
    key(ed, '2')
    ed.commands.setTextSelection(6)
    key(ed, 'd')
    key(ed, 'd')
    expect(ed.getHTML()).toBe('<p>one</p><p>three</p>')

    ed.commands.setContent('<p>one</p><p>two</p><p>three</p>')
    ed.commands.setTextSelection(1)
    key(ed, '2')
    key(ed, 'V')
    ed.commands.setTextSelection(6)
    key(ed, 'd')
    key(ed, 'd')
    expect(ed.getHTML()).toBe('<p>one</p><p>three</p>')

    ed.commands.setContent('<p>one</p><p>two</p><p>three</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'g')
    ed.commands.setTextSelection(6)
    key(ed, 'd')
    key(ed, 'd')
    expect(ed.getHTML()).toBe('<p>one</p><p>three</p>')

    ed.commands.setContent('<p>one</p><p>two</p><p>three</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'd')
    key(ed, 'j')
    expect(ed.getHTML()).toBe('<p>three</p>')
  })

  it('extends counted forward-character operators through only available graphemes', () => {
    for (const count of [1, 2, 3]) {
      for (const operation of ['d', 'c'] as const) {
        const ed = open('<p>a👩‍💻éB</p><p>other</p>')
        ed.commands.setTextSelection(7)
        key(ed, operation)
        key(ed, String(count))
        key(ed, 'l')
        if (operation === 'c') {
          ed.view.dispatch(ed.state.tr.insertText('X'))
          key(ed, 'Escape')
        }
        expect(ed.getHTML()).toBe(
          operation === 'c'
            ? `<p>a👩‍💻X${count === 1 ? 'B' : ''}</p><p>other</p>`
            : `<p>a👩‍💻${count === 1 ? 'B' : ''}</p><p>other</p>`,
        )
      }
    }
    for (const operation of ['d', 'c'] as const) {
      const final = open('<p>one</p>')
      final.commands.setTextSelection(3)
      key(final, operation)
      key(final, 'l')
      if (operation === 'c') {
        expect(final.view.dom.dataset.vimMode).toBe('insert')
        final.view.dispatch(final.state.tr.insertText('X'))
        key(final, 'Escape')
      }
      expect(final.getHTML()).toBe(operation === 'c' ? '<p>onX</p>' : '<p>on</p>')
    }

    const empty = open('<p></p><p>next</p>')
    empty.commands.setTextSelection(1)
    key(empty, 'd')
    key(empty, 'l')
    expect(empty.getHTML()).toBe('<p></p><p>next</p>')
  })

  it('positions linewise paste on the first inserted logical line', () => {
    for (const [source, target, selector, expected] of [
      ['<pre><code>first</code></pre>', '<pre><code>other</code></pre>', 'code', 'other\nirst'],
      [
        '<p>first<br>second</p>',
        '<p>other<br>tail</p>',
        'hardBreak',
        '<p>other<br>irst<br>tail</p>',
      ],
    ] as const) {
      const ed = open(source)
      ed.commands.setTextSelection(1)
      key(ed, 'y')
      key(ed, 'y')
      ed.commands.setContent(target)
      ed.commands.setTextSelection(1)
      key(ed, 'p')
      expect(ed.state.doc.check()).toBeUndefined()
      key(ed, 'x')
      expect(selector === 'code' ? ed.state.doc.firstChild?.textContent : ed.getHTML()).toBe(
        expected,
      )
    }

    for (const put of ['p', 'P'] as const) {
      const ed = open('<pre><code>first</code></pre>')
      ed.commands.setTextSelection(1)
      key(ed, 'y')
      key(ed, 'y')
      ed.commands.setContent('<pre><code>other</code></pre>')
      ed.commands.setTextSelection(1)
      key(ed, '2')
      key(ed, put)
      key(ed, 'x')
      expect(ed.state.doc.firstChild?.textContent).toBe(
        put === 'p' ? 'other\nirst\nfirst' : 'irst\nfirst\nother',
      )
    }
  })

  it('uses counted logical-line destinations for dollar operators', () => {
    for (const [markup, expectedFor, textPos] of [
      [
        '<pre><code>one\ntwo\nthree</code></pre>',
        (count: number) => (count === 2 ? '\nthree' : ''),
        1,
      ],
      [
        '<p>one<br>two<br>three</p>',
        (count: number) => (count === 2 ? '<p><br>three</p>' : '<p></p>'),
        1,
      ],
    ] as const) {
      for (const count of [2, 3]) {
        const ed = open(markup)
        ed.commands.setTextSelection(textPos)
        key(ed, 'd')
        key(ed, String(count))
        key(ed, '$')
        expect(
          markup.startsWith('<pre>') ? ed.state.doc.firstChild?.textContent : ed.getHTML(),
        ).toBe(expectedFor(count))
      }
    }

    const code = open('<pre><code>one\n👩‍💻two\nthree</code></pre>')
    code.commands.setTextSelection(1)
    key(code, '2')
    key(code, 'd')
    key(code, '$')
    expect(code.state.doc.firstChild?.textContent).toBe('\nthree')

    code.commands.setContent('<pre><code>one\n👩‍💻two\nthree</code></pre>')
    code.commands.setTextSelection(5)
    key(code, 'd')
    key(code, '2')
    key(code, '$')
    expect(code.state.doc.firstChild?.textContent).toBe('one\n')

    code.commands.setContent('<pre><code>one\ntwo\nthree</code></pre>')
    code.commands.setTextSelection(1)
    key(code, 'y')
    key(code, '2')
    key(code, '$')
    code.commands.setTextSelection(9)
    key(code, 'P')
    expect(code.state.doc.firstChild?.textContent).toBe('one\ntwo\none\ntwothree')

    code.commands.setContent('<pre><code>one\ntwo\nthree</code></pre>')
    code.commands.setTextSelection(1)
    key(code, 'c')
    key(code, '2')
    key(code, '$')
    code.view.dispatch(code.state.tr.insertText('X'))
    expect(code.state.doc.firstChild?.textContent).toBe('X\nthree')
    key(code, 'Escape')
    key(code, 'u')
    expect(code.state.doc.firstChild?.textContent).toBe('one\ntwo\nthree')
  })

  it('deletes logical lines without leaving separators or phantom lines', () => {
    for (const markup of [
      '<pre><code>first\nmiddle\nlast</code></pre>',
      '<p>first<br>middle<br>last</p>',
    ]) {
      const isCode = markup.startsWith('<pre>')
      const cases = [
        {
          start: 1,
          keys: ['d', 'd'],
          expectedCode: 'middle\nlast',
          expectedHtml: '<p>middle<br>last</p>',
        },
        {
          start: 8,
          keys: ['d', 'd'],
          expectedCode: 'first\nlast',
          expectedHtml: '<p>first<br>last</p>',
        },
        {
          start: 14,
          keys: ['d', 'd'],
          expectedCode: 'first\nmiddle',
          expectedHtml: '<p>first<br>middle</p>',
        },
        {
          start: 1,
          keys: ['V', 'd'],
          expectedCode: 'middle\nlast',
          expectedHtml: '<p>middle<br>last</p>',
        },
        {
          start: 8,
          keys: ['V', 'd'],
          expectedCode: 'first\nlast',
          expectedHtml: '<p>first<br>last</p>',
        },
        {
          start: 14,
          keys: ['V', 'd'],
          expectedCode: 'first\nmiddle',
          expectedHtml: '<p>first<br>middle</p>',
        },
      ] as const
      for (const { start, keys, expectedCode, expectedHtml } of cases) {
        const ed = open(markup)
        ed.commands.setTextSelection(start)
        for (const value of keys) key(ed, value)
        expect(isCode ? ed.state.doc.firstChild?.textContent : ed.getHTML()).toBe(
          isCode ? expectedCode : expectedHtml,
        )
        expect(ed.state.doc.check()).toBeUndefined()
      }
    }

    const counted = open('<pre><code>first\nmiddle\nlast</code></pre>')
    counted.commands.setTextSelection(1)
    key(counted, '2')
    key(counted, 'd')
    key(counted, 'd')
    expect(counted.state.doc.firstChild?.textContent).toBe('last')
  })

  it('removes a table-cell paragraph when sibling content remains', () => {
    const ed = openTable()
    ed.commands.setContent(
      '<table><tbody><tr><td><p>first</p><p>second</p></td></tr></tbody></table>',
    )
    let first = 0
    ed.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'first') first = pos
    })
    ed.commands.setTextSelection(first)
    key(ed, 'd')
    key(ed, 'd')
    expect(ed.state.doc.firstChild?.type.name).toBe('table')
    expect(ed.state.doc.firstChild?.firstChild?.firstChild?.firstChild?.textContent).toBe('second')
    expect(ed.state.doc.check()).toBeUndefined()
  })

  it('moves counted dollar motions across logical lines inside their container', () => {
    for (const sequence of [
      ['2', '$'],
      ['v', '2', '$'],
    ] as const) {
      const ed = open('<pre><code>first\nmiddle\nlast</code></pre>')
      ed.commands.setTextSelection(1)
      for (const value of sequence) key(ed, value)
      expect(ed.state.selection.$head.parentOffset).toBeGreaterThan(6)
      expect(ed.state.selection.$head.parentOffset).toBeLessThan(13)
    }
  })

  it('rejects a visual line deletion that spans partial paragraph blocks', () => {
    for (const [content, position] of [
      ['<p>keep<br>delete</p><p>next</p>', 'delete'],
      ['<p>next</p><p>keep<br>delete</p>', 'delete'],
      ['<pre><code>keep\\ndelete</code></pre><p>next</p>', 'delete'],
      ['<ul><li><p>keep</p><p>delete</p></li><li><p>next</p></li></ul>', 'delete'],
    ] as const) {
      const feedback = vi.fn()
      const ed = open(content, true, feedback)
      let at = 0
      ed.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === position) at = pos
      })
      ed.commands.setTextSelection(at)
      const before = ed.state.doc
      key(ed, 'V')
      key(ed, 'd')
      expect.soft(ed.state.doc.eq(before), content).toBe(true)
      expect.soft(feedback).toHaveBeenCalled()
      expect(ed.view.dom.dataset.vimMode).toBe('normal')
    }
  })

  it('rejects c2w across table cells without changing the previous register or history', () => {
    const feedback = vi.fn()
    const ed = openTable(feedback)
    ed.commands.setContent(
      '<table><tbody><tr><td><p>alpha</p></td><td><p></p></td></tr></tbody></table>',
    )
    let alpha = 0
    ed.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'alpha') alpha = pos
    })
    ed.commands.setTextSelection(alpha)
    key(ed, 'y')
    key(ed, 'w')
    key(ed, 'c')
    key(ed, '2')
    const before = ed.state.doc
    key(ed, 'w')
    expect(ed.state.doc.eq(before)).toBe(true)
    expect(ed.view.dom.dataset.vimMode).toBe('normal')
    expect(feedback).toHaveBeenCalled()
    key(ed, 'p')
    expect(ed.state.doc.textContent).toBe('aalphalpha')
    expect(ed.state.doc.check()).toBeUndefined()
    key(ed, 'u')
    expect(ed.state.doc.textContent).toBe('alpha')

    const noHistory = new Editor({
      extensions: [
        StarterKit,
        TableKit,
        RichTextVim.configure({ enabled: false, editable: () => true }),
      ],
      content: '<table><tbody><tr><td><p>alpha</p></td><td><p></p></td></tr></tbody></table>',
    })
    own(noHistory)
    configureRichTextVim(noHistory.view, true, true, () => true)
    let noHistoryAlpha = 0
    noHistory.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'alpha') noHistoryAlpha = pos
    })
    noHistory.commands.setTextSelection(noHistoryAlpha)
    const beforeRejectedUndo = noHistory.state.doc
    key(noHistory, 'c')
    key(noHistory, '2')
    key(noHistory, 'w')
    key(noHistory, 'u')
    expect(noHistory.state.doc.eq(beforeRejectedUndo)).toBe(true)
  })

  it('deletes empty first logical lines without retaining a leading separator', () => {
    for (const markup of ['<pre><code>\nnext</code></pre>', '<p><br>next</p>']) {
      const ed = open(markup)
      ed.commands.setTextSelection(1)
      key(ed, 'V')
      key(ed, 'd')
      expect.soft(ed.state.doc.firstChild?.textContent, markup).toBe('next')
      expect(ed.state.doc.check()).toBeUndefined()
    }

    const empty = open('<pre><code>\nnext</code></pre>')
    empty.commands.setTextSelection(1)
    key(empty, 'y')
    key(empty, 'y')
    empty.commands.setTextSelection(empty.state.doc.content.size - 1)
    key(empty, 'p')
    expect(empty.state.doc.firstChild?.textContent).toBe('\nnext\n')
    expect(empty.state.doc.check()).toBeUndefined()

    const changed = open('<pre><code>\nnext</code></pre>')
    changed.commands.setTextSelection(1)
    key(changed, 'V')
    key(changed, 'c')
    changed.view.dispatch(changed.state.tr.insertText('X'))
    expect(changed.state.doc.firstChild?.textContent).toBe('X\nnext')
    expect(changed.state.doc.check()).toBeUndefined()
  })

  it('normalizes destructive operator carets to the remaining grapheme', () => {
    const ed = open('<p>one</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'd')
    key(ed, '$')
    expect(ed.getHTML()).toBe('<p></p>')
    expect(ed.state.selection.head).toBe(1)
    key(ed, 'x')
    expect(ed.getHTML()).toBe('<p></p>')

    ed.commands.setContent('<p>one</p>')
    ed.commands.setTextSelection(1)
    key(ed, 'V')
    key(ed, 'd')
    expect(ed.getHTML()).toBe('<p></p>')
    expect(ed.state.doc.check()).toBeUndefined()

    ed.commands.setContent('<h2><strong>Heading</strong></h2><p>next</p>')
    ed.commands.setTextSelection(3)
    key(ed, 'y')
    key(ed, 'y')
    key(ed, 'p')
    expect(ed.state.doc.firstChild?.type.name).toBe('heading')
    expect(ed.state.doc.firstChild?.attrs.level).toBe(2)
    expect(ed.state.doc.firstChild?.firstChild?.marks.map((mark) => mark.type.name)).toEqual([
      'bold',
    ])
  })

  it('deletes a long-first-paragraph list item from its later paragraph and can undo it', () => {
    for (const task of [false, true]) {
      const content = task
        ? '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>LONG FIRST PARAGRAPH CONTENT</p><p>second</p></li><li data-type="taskItem" data-checked="false"><p>next</p></li></ul>'
        : '<ul><li><p>LONG FIRST PARAGRAPH CONTENT</p><p>second</p></li><li><p>next</p></li></ul>'
      const ed = new Editor({
        extensions: [
          StarterKit,
          ...(task ? [TaskList, RichTextTaskItem.configure({ nested: true })] : []),
          RichTextVim.configure({ enabled: false, editable: () => true }),
        ],
        content,
      })
      own(ed)
      configureRichTextVim(ed.view, true, true, () => true)
      let second = 0
      ed.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === 'second') second = pos
      })
      ed.commands.setTextSelection(second)
      key(ed, 'V')
      key(ed, 'd')
      expect(ed.state.doc.check()).toBeUndefined()
      expect(ed.state.doc.textContent).toBe('next')
      key(ed, 'u')
      expect(ed.state.doc.textContent).toContain('LONG FIRST PARAGRAPH CONTENTsecond')
      expect(ed.state.doc.firstChild?.childCount).toBe(2)
    }
  })

  it('preserves heading structure on linewise yank/paste and keeps nested table actions local', () => {
    const ed = open('<h2><strong>Heading</strong></h2><p>next</p>')
    ed.commands.setTextSelection(2)
    key(ed, 'y')
    key(ed, 'y')
    ed.commands.setTextSelection(ed.state.doc.content.size - 1)
    key(ed, 'p')
    expect(ed.state.doc.child(0).type.name).toBe('heading')
    expect(ed.state.doc.child(0).attrs.level).toBe(2)
    expect(ed.state.doc.child(0).firstChild?.marks.map((mark) => mark.type.name)).toEqual(['bold'])
    expect(ed.state.doc.child(1).type.name).toBe('paragraph')
    expect(ed.state.doc.child(2).type.name).toBe('heading')
    expect(ed.state.doc.child(2).attrs.level).toBe(2)
    expect(ed.state.doc.child(2).firstChild?.marks.map((mark) => mark.type.name)).toEqual(['bold'])
    expect(ed.state.doc.check()).toBeUndefined()

    ed.commands.setContent('<h2><strong>Heading</strong></h2><p>next</p>')
    ed.commands.setTextSelection(2)
    key(ed, 'y')
    key(ed, 'y')
    let next = 0
    ed.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'next') next = pos
    })
    ed.commands.setTextSelection(next)
    key(ed, 'c')
    key(ed, 'c')
    ed.view.dispatch(ed.state.tr.insertText('X'))
    expect(ed.state.doc.textContent).toBe('HeadingX')
    key(ed, 'Escape')
    key(ed, 'p')
    expect(ed.state.doc.toJSON()).toMatchObject({
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Heading' }],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'X' }] },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Heading' }],
        },
      ],
    })
    expect(ed.state.doc.check()).toBeUndefined()

    const nested = new Editor({
      extensions: [
        StarterKit,
        TableKit,
        RichTextVim.configure({ enabled: false, editable: () => true }),
      ],
      content:
        '<ul><li><p>outer</p><table><tbody><tr><th><p>head</p></th><td><p>other</p></td></tr></tbody></table><p>tail</p></li><li><p>sibling</p></li></ul>',
    })
    own(nested)
    configureRichTextVim(nested.view, true, true, () => true)
    let head = 0
    nested.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'head') head = pos
    })
    nested.commands.setTextSelection(head)
    key(nested, 'd')
    key(nested, 'd')
    expect(nested.state.doc.textContent).toContain('outer')
    expect(nested.state.doc.textContent).toContain('sibling')
    expect(nested.state.doc.textContent).toContain('other')
    expect(nested.state.doc.textContent).toContain('tail')
    expect(nested.state.doc.check()).toBeUndefined()
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
    own(ed)
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
