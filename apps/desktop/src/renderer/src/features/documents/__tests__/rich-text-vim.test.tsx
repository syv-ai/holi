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
    expect(ed.state.doc.firstChild?.textContent).toBe('first\nmiddle\nlast')
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
