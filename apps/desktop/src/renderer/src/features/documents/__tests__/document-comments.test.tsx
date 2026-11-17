/**
 * A thread's anchor quotes the file's markdown, the editor holds rich text:
 * a selection becomes a quote the file has, and a thread's quote becomes the
 * editor's range over the same words, through formatting, headings, lists
 * and the frontmatter kept aside.
 */
import { anchorAt, type CommentThread } from '@holi/shared'
import { Editor } from '@tiptap/react'
import { afterEach, describe, expect, it } from 'vitest'

import { RichTextTable } from '@/features/documents/rich-text/rich-text-table'

import {
  DocumentComments,
  placeThreads,
  selectionAnchor,
  selectionLines,
  setCommentRanges,
  threadsAt,
} from '../document-comments'
import { createDocumentExtensions } from '../document-extensions'
import { configureRichTextVim, RichTextVim } from '../rich-text-vim'

let editor: Editor | null = null
afterEach(() => editor?.destroy())

function open(body: string): Editor {
  editor = new Editor({
    extensions: [
      ...createDocumentExtensions({
        folder: 'notes',
        placeholder: '',
        onOpenLink: () => undefined,
      }),
      RichTextTable,
      RichTextVim.configure({ enabled: false, editable: () => editor?.isEditable ?? false }),
      DocumentComments,
    ],
    content: body,
    contentType: 'markdown',
  })
  return editor
}

/** The editor's range over the first `words`. */
function rangeOf(ed: Editor, words: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null
  ed.state.doc.descendants((node, pos) => {
    if (found || !node.isText) return
    const at = node.text!.indexOf(words)
    if (at !== -1) found = { from: pos + at, to: pos + at + words.length }
  })
  if (!found) throw new Error(`no ${words}`)
  return found
}

function thread(id: string, text: string, quote: string): CommentThread {
  const at = text.indexOf(quote)
  return {
    id,
    anchor: anchorAt(text, at, at + quote.length),
    comments: [],
    status: null,
  }
}

describe('selectionAnchor', () => {
  it('quotes plain words as the file has them', () => {
    const ed = open('# Plan\n\nShip the beta on Friday.\n')
    const { from, to } = rangeOf(ed, 'the beta')
    ed.commands.setTextSelection({ from, to })
    const anchor = selectionAnchor(ed, '')
    expect(anchor?.quote).toBe('the beta')
    expect(anchor?.line).toBe(3)
    expect(anchor?.prefix.endsWith('Ship ')).toBe(true)
  })

  it('quotes and restores passages inside a native image caption', () => {
    const body =
      '<!-- holi:figure -->\n\n![cat](../assets/cat.png)\n\n<!-- holi:caption -->\n\nA **bold** caption\n\n<!-- /holi:figure -->'
    const ed = open(body)
    expect(ed.state.doc.firstChild?.type.name).toBe('documentFigure')
    const { from, to } = rangeOf(ed, 'bold')
    ed.commands.setTextSelection({ from, to })
    const anchor = selectionAnchor(ed, '')!
    const markdown = ed.getMarkdown()
    expect(markdown).toContain(anchor.quote)
    expect(anchor.quote.replace(/\*/g, '')).toBe('bold')
    expect(placeThreads(ed, '', [thread('caption', markdown, anchor.quote)])).toHaveLength(1)
  })

  it('quotes through formatting, so the quote is in the file', () => {
    const body = 'Ship **the beta** on Friday.\n'
    const ed = open(body)
    const { from } = rangeOf(ed, 'Ship')
    const { to } = rangeOf(ed, ' on')
    ed.commands.setTextSelection({ from, to })
    const anchor = selectionAnchor(ed, '')!
    expect(body).toContain(anchor.quote)
    expect(anchor.quote.replace(/\*/g, '')).toBe('Ship the beta on')
  })

  it('counts the frontmatter in the line and the context', () => {
    const head = '---\ntitle: Plan\n---\n\n'
    const ed = open('Ship it.\n')
    const { from, to } = rangeOf(ed, 'Ship')
    ed.commands.setTextSelection({ from, to })
    const anchor = selectionAnchor(ed, head)!
    expect(anchor.line).toBe(5)
    expect(anchor.prefix).toBe(head)
  })

  it('is null for an empty selection', () => {
    const ed = open('Ship it.\n')
    expect(selectionAnchor(ed, '')).toBeNull()
  })
})

describe('placeThreads', () => {
  it("places a quote on the editor's range over the same words", () => {
    const body = '# Plan\n\nShip **the beta** on Friday.\n\n- one item\n- two items\n'
    const ed = open(body)
    const text = ed.getMarkdown()
    const placed = placeThreads(ed, '', [
      thread('a', text, 'the beta'),
      thread('b', text, 'Plan'),
      thread('c', text, 'two items'),
    ])
    const at = (id: string) => placed.find((p) => p.id === id)!
    const words = (id: string) => ed.state.doc.textBetween(at(id).from, at(id).to)
    expect(words('a')).toBe('the beta')
    expect(words('b')).toBe('Plan')
    expect(words('c')).toBe('two items')
  })

  it('keeps a heading a heading when the quote starts with its #', () => {
    const ed = open('## Goals\n\nText.\n')
    const text = ed.getMarkdown()
    const [placed] = placeThreads(ed, '', [thread('a', text, '## Goals')])
    expect(ed.state.doc.textBetween(placed!.from, placed!.to)).toBe('Goals')
  })

  it('leaves out a detached thread and one in the frontmatter', () => {
    const head = '---\ntitle: Plan\n---\n\n'
    const ed = open('Ship it.\n')
    const text = head + ed.getMarkdown()
    const gone: CommentThread = {
      ...thread('a', text, 'Ship'),
      anchor: { quote: 'nowhere at all', prefix: '', suffix: '', line: 1 },
    }
    expect(placeThreads(ed, head, [gone, thread('b', text, 'title: Plan')])).toEqual([])
  })

  it('places overlapping threads independently', () => {
    const ed = open('one two three four\n')
    const text = ed.getMarkdown()
    const placed = placeThreads(ed, '', [
      thread('a', text, 'one two three'),
      thread('b', text, 'two three four'),
    ])
    const words = (id: string) => {
      const p = placed.find((r) => r.id === id)!
      return ed.state.doc.textBetween(p.from, p.to)
    }
    expect(words('a')).toBe('one two three')
    expect(words('b')).toBe('two three four')
  })

  it('draws the placed passages and says which a position is in', () => {
    const ed = open('one two three\n')
    const text = ed.getMarkdown()
    const ranges = placeThreads(ed, '', [thread('a', text, 'two')])
    setCommentRanges(ed, { ranges, active: 'a' })
    const { from } = rangeOf(ed, 'two')
    expect(threadsAt(ed.state, from)).toEqual(['a'])
    expect(threadsAt(ed.state, from - 2)).toEqual([])
    // An edit before the passage moves the tint with it.
    ed.commands.insertContentAt(1, 'zero ')
    expect(threadsAt(ed.state, from + 5)).toEqual(['a'])
  })

  it.each([
    { label: 'paragraph', body: 'alpha beta\n', expectedBlock: 'paragraph' },
    { label: 'heading', body: '## alpha beta\n', expectedBlock: 'heading' },
    { label: 'checked task', body: '- [x] alpha beta\n', expectedBlock: 'task' },
  ])('tracks a Vim line change from its insertion point in a $label', ({ body, expectedBlock }) => {
    const ed = open(body)
    const markdown = ed.getMarkdown()
    const [range] = placeThreads(ed, '', [thread('a', markdown, 'alpha')])
    setCommentRanges(ed, { ranges: [range!] })
    configureRichTextVim(ed.view, true, true, () => true)
    ed.commands.setTextSelection(range!.from)
    const press = (value: string) =>
      ed.view.dom.dispatchEvent(
        new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
      )

    press('c')
    press('c')

    if (expectedBlock === 'heading') expect(ed.state.doc.firstChild?.type.name).toBe('heading')
    if (expectedBlock === 'heading') expect(ed.state.doc.firstChild?.attrs.level).toBe(2)
    if (expectedBlock === 'task') {
      expect(ed.state.doc.firstChild?.firstChild?.type.name).toBe('taskItem')
      expect(ed.state.doc.firstChild?.firstChild?.attrs.checked).toBe(true)
    }
    for (const character of 'omega') {
      ed.view.dispatch(ed.state.tr.insertText(character))
      const { head } = ed.state.selection
      expect(ed.state.doc.textBetween(head - 1, head)).toBe(character)
      expect(threadsAt(ed.state, head - 1)).toEqual(['a'])
    }
    expect(ed.state.doc.textContent).toContain('omega')
  })

  it.each(['move', 'blur'] as const)(
    'cancels Vim line-change comment tracking after %s',
    (cancel) => {
      const ed = open('alpha beta\n')
      const markdown = ed.getMarkdown()
      const [range] = placeThreads(ed, '', [thread('a', markdown, 'alpha')])
      setCommentRanges(ed, { ranges: [range!] })
      configureRichTextVim(ed.view, true, true, () => true)
      ed.commands.setTextSelection(range!.from)
      const press = (value: string) =>
        ed.view.dom.dispatchEvent(
          new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
        )

      press('c')
      press('c')
      ed.view.dispatch(ed.state.tr.insertText('a'))
      const { head } = ed.state.selection
      if (cancel === 'move') ed.commands.setTextSelection(head - 1)
      else ed.view.dom.dispatchEvent(new FocusEvent('blur'))
      ed.view.dispatch(ed.state.tr.insertText('!'))

      const inserted = rangeOf(ed, '!')
      expect(threadsAt(ed.state, inserted.from)).toEqual([])
    },
  )

  it('keeps a Vim change comment over character-by-character insertions', () => {
    const ed = open('alpha beta\n')
    const markdown = ed.getMarkdown()
    const [range] = placeThreads(ed, '', [thread('a', markdown, 'alpha')])
    setCommentRanges(ed, { ranges: [range!] })
    configureRichTextVim(ed.view, true, true, () => true)
    ed.commands.setTextSelection(range!.from)
    const press = (value: string) =>
      ed.view.dom.dispatchEvent(
        new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
      )

    press('c')
    press('w')
    for (const character of 'omega') ed.view.dispatch(ed.state.tr.insertText(character))

    const { from, to } = rangeOf(ed, 'omega')
    expect(ed.state.doc.textBetween(from, to)).toBe('omega')
    expect(threadsAt(ed.state, from)).toEqual(['a'])
    expect(threadsAt(ed.state, to - 1)).toEqual(['a'])
  })

  it.each([
    { operation: ['d', 'w'], body: 'alpha beta\n' },
    { operation: ['d', 'd'], body: 'alpha\nbeta\n' },
  ])('does not reanchor a comment after destructive Vim $operation', ({ operation, body }) => {
    const ed = open(body)
    const markdown = ed.getMarkdown()
    const [range] = placeThreads(ed, '', [thread('a', markdown, 'alpha')])
    setCommentRanges(ed, { ranges: [range!] })
    configureRichTextVim(ed.view, true, true, () => true)
    ed.commands.setTextSelection(range!.from)
    const press = (value: string) =>
      ed.view.dom.dispatchEvent(
        new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
      )

    for (const key of operation) press(key)
    press('i')
    ed.view.dispatch(ed.state.tr.insertText('!'))

    const inserted = rangeOf(ed, '!')
    expect(threadsAt(ed.state, inserted.from)).toEqual([])
  })

  it('does not extend a replacement comment after deleting at its end', () => {
    const ed = open('alpha beta\n')
    const markdown = ed.getMarkdown()
    const [range] = placeThreads(ed, '', [thread('a', markdown, 'alpha')])
    setCommentRanges(ed, { ranges: [range!] })
    configureRichTextVim(ed.view, true, true, () => true)
    ed.commands.setTextSelection(range!.from)
    const press = (value: string) =>
      ed.view.dom.dispatchEvent(
        new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
      )

    press('c')
    press('w')
    for (const character of 'omega') ed.view.dispatch(ed.state.tr.insertText(character))
    const { from, to } = rangeOf(ed, 'omega')
    ed.view.dispatch(ed.state.tr.delete(to - 1, to))
    ed.view.dispatch(ed.state.tr.insertText('!', to - 1))

    expect(threadsAt(ed.state, from)).toEqual(['a'])
    expect(threadsAt(ed.state, to - 1)).toEqual([])
  })

  it('stops extending a replacement comment after Vim leaves insert mode', () => {
    const ed = open('alpha beta\n')
    const markdown = ed.getMarkdown()
    const [range] = placeThreads(ed, '', [thread('a', markdown, 'alpha')])
    setCommentRanges(ed, { ranges: [range!] })
    configureRichTextVim(ed.view, true, true, () => true)
    ed.commands.setTextSelection(range!.from)
    const press = (value: string) =>
      ed.view.dom.dispatchEvent(
        new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
      )

    press('c')
    press('w')
    for (const character of 'omega') ed.view.dispatch(ed.state.tr.insertText(character))
    press('Escape')
    const end = rangeOf(ed, 'omega').to
    ed.view.dispatch(ed.state.tr.insertText('!', end))

    expect(threadsAt(ed.state, rangeOf(ed, 'omega').from)).toEqual(['a'])
    expect(threadsAt(ed.state, end)).toEqual([])
  })

  it('moves a comment range onto text inserted by a Vim change operator', () => {
    const ed = open('alpha beta\n')
    const markdown = ed.getMarkdown()
    const [range] = placeThreads(ed, '', [thread('a', markdown, 'alpha')])
    setCommentRanges(ed, { ranges: [range!] })
    configureRichTextVim(ed.view, true, true, () => true)
    ed.commands.setTextSelection(range!.from)
    const press = (value: string) =>
      ed.view.dom.dispatchEvent(
        new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
      )

    press('c')
    press('w')
    ed.view.dispatch(ed.state.tr.insertText('omega'))

    const { from } = rangeOf(ed, 'omega')
    expect(threadsAt(ed.state, from), ed.view.dom.innerHTML).toEqual(['a'])
  })
})

describe('selectionLines', () => {
  it("numbers the file's lines, frontmatter included, as Read does", () => {
    const head = '---\ntitle: Plan\n---\n\n'
    const ed = open('# Plan\n\nShip the beta.\n\nThen the launch.\n')
    const { from } = rangeOf(ed, 'the beta')
    const { to } = rangeOf(ed, 'the launch')
    ed.commands.setTextSelection({ from, to })
    // The head is lines 1 to 4; "# Plan" is line 5.
    expect(selectionLines(ed, head)).toEqual({ startLine: 7, endLine: 9 })
  })

  it('is null for a caret', () => {
    const ed = open('Ship it.\n')
    ed.commands.setTextSelection(2)
    expect(selectionLines(ed, '')).toBeNull()
  })
})
