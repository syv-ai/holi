import { Editor } from '@tiptap/react'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDocumentExtensions } from '../document-extensions'
import { RichTextTable } from '../rich-text/rich-text-table'

const editors: Editor[] = []
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
beforeEach(() => {
  // JSDOM has no layout/scrolling. Native acceptance covers the actual scroll.
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value() {},
  })
})
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  document.body.replaceChildren()
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll)
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
})

function open(markdown: string, onOpenLink = vi.fn()) {
  const element = document.createElement('div')
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: [
      ...createDocumentExtensions({ folder: 'notes', placeholder: '', onOpenLink }),
      RichTextTable,
    ],
    content: markdown,
    contentType: 'markdown',
  })
  editors.push(editor)
  return editor
}

function references(editor: Editor) {
  return Array.from(editor.view.dom.querySelectorAll<HTMLAnchorElement>('sup a'))
}

function selectedPosition(editor: Editor) {
  const selection = document.getSelection()!
  return editor.view.posAtDOM(selection.anchorNode!, selection.anchorOffset)
}

describe('document footnotes', () => {
  it('edits rich multiline definitions and keeps their content and ordinary references on reopen', () => {
    const source =
      'Body[^a] and another[^b].\n\n[^a]: First **bold** paragraph.\n\n    Another paragraph with [site][home].\n\n        code sample\n\n[^b]: Second note.\n\n[home]: https://example.com'
    const editor = open(source)
    const bold = editor.view.dom.querySelector('li strong')!
    editor.commands.insertContentAt(
      {
        from: editor.view.posAtDOM(bold.firstChild!, 0),
        to: editor.view.posAtDOM(bold.firstChild!, 4),
      },
      '<strong>edited bold</strong>',
    )
    let saved = editor.getMarkdown()
    expect(saved).toContain('**edited bold**')
    expect(saved).toContain('[home]: https://example.com')
    for (let cycle = 0; cycle < 2; cycle++) {
      const reopened = open(saved)
      expect(reopened.view.dom.querySelectorAll('ol > li')).toHaveLength(2)
      expect(reopened.view.dom.textContent).toContain('Another paragraph with site.')
      expect(reopened.view.dom.querySelector('li a[href="https://example.com"]')).not.toBeNull()
      expect(reopened.getMarkdown()).toContain('code sample')
      expect(reopened.getMarkdown()).toContain('[^b]: Second note.')
      expect(reopened.getMarkdown()).toBe(saved)
      saved = reopened.getMarkdown()
    }
  })

  it('keeps escaped markers, examples and unresolved references literal without dropping unused definitions', () => {
    const source =
      'Literal \\[^literal] and `[^code]`. Unresolved[^missing].\n\n```md\n[^fake]: Not a note.\n```\n\n<pre>\n[^html]: Still HTML.\n</pre>\n\n[^unused]: Kept note.'
    const editor = open(source)
    expect(references(editor)).toHaveLength(0)
    expect(editor.view.dom.textContent).toContain(
      'Literal [^literal] and [^code]. Unresolved[^missing].',
    )
    expect(editor.view.dom.querySelectorAll('ol > li')).toHaveLength(1)
    const saved = editor.getMarkdown()
    expect(saved).toContain('`[^code]`')
    expect(saved).toContain('[^fake]: Not a note.')
    expect(saved).toContain('[^html]: Still HTML.')
    expect(saved).toContain('[^unused]: Kept note.')
    expect(open(saved).getMarkdown()).toBe(saved)
  })

  it('navigates repeated references by mouse and keyboard only in their owning editor, including after edits', () => {
    const source = 'First[^a], repeated[^a], second[^b].\n\n[^a]: First note.\n\n[^b]: Second note.'
    const externalOpen = vi.fn()
    const editor = open(source, externalOpen)
    const other = open(source, externalOpen)
    const ids = [
      ...editor.view.dom.querySelectorAll('[id]'),
      ...other.view.dom.querySelectorAll('[id]'),
    ].map((element) => element.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(references(editor).map((anchor) => anchor.textContent)).toEqual(['1', '1', '2'])
    const hash = location.hash
    for (let iteration = 0; iteration < 2; iteration++) {
      const before = editor.getMarkdown()
      const reference = references(editor)[1]!
      const sup = reference.parentElement!
      const parent = sup.parentNode!
      const returnPosition = editor.view.posAtDOM(
        parent,
        Array.from(parent.childNodes).indexOf(sup) + 1,
      )
      fireEvent.click(reference)
      const note = editor.view.dom.querySelector('ol > li')!
      expect(note.contains(document.getSelection()!.anchorNode)).toBe(true)
      expect(other.view.dom.contains(document.getSelection()!.anchorNode)).toBe(false)
      const backlinks = note.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')
      expect(backlinks).toHaveLength(2)
      backlinks[1]!.focus()
      fireEvent.keyDown(backlinks[1]!, { key: 'Enter' })
      expect(selectedPosition(editor)).toBe(returnPosition)
      expect(editor.getMarkdown()).toBe(before)
      expect(location.hash).toBe(hash)
      editor.commands.insertContentAt(1, 'Prefix ')
    }
    expect(externalOpen).not.toHaveBeenCalled()
    expect(other.getMarkdown()).toBe(open(source).getMarkdown())
  })

  it('uses the first matching definition without discarding duplicate definitions on load or setContent', () => {
    const source =
      'See[^A] and[^Æ].\n\n[^a]: First definition.\n\n[^A]: Duplicate definition.\n\n[^æ]: Unicode note.'
    const editor = open('Old content.')
    editor.commands.setContent(source, { contentType: 'markdown' })
    expect(editor.view.dom.querySelectorAll('ol > li')).toHaveLength(3)
    const exported = new DOMParser().parseFromString(editor.getHTML(), 'text/html')
    const exportedNotes = Array.from(exported.querySelectorAll('li'))
    const exportedReferences = exported.querySelectorAll<HTMLAnchorElement>('sup a')
    expect(
      Array.from(
        exportedReferences,
        (anchor) =>
          exportedNotes.find((note) => note.id === decodeURIComponent(anchor.hash.slice(1)))
            ?.textContent,
      ),
    ).toEqual(['First definition.', 'Unicode note.'])
    fireEvent.click(references(editor)[0]!)
    expect(
      editor.view.dom.querySelector('ol > li')!.contains(document.getSelection()!.anchorNode),
    ).toBe(true)
    const saved = editor.getMarkdown()
    expect(saved).toContain('[^a]: First definition.')
    expect(saved).toContain('[^A]: Duplicate definition.')
    expect(open(saved).getMarkdown()).toBe(saved)
  })
})
