import { Editor } from '@tiptap/react'
import { afterEach, describe, expect, it } from 'vitest'

import { createDocumentExtensions } from '../document-extensions'

let editor: Editor | null = null
afterEach(() => editor?.destroy())

function empty(): Editor {
  editor = new Editor({
    extensions: createDocumentExtensions({
      folder: 'notes',
      placeholder: '',
      onOpenLink: () => undefined,
    }),
    content: '',
    contentType: 'markdown',
  })
  return editor
}

/** Types `text` one character at a time, as a keyboard would. */
function type(editor: Editor, text: string) {
  for (const char of text) {
    const { from, to } = editor.state.selection
    const handled = editor.view.someProp('handleTextInput', (f) =>
      f(editor.view, from, to, char, () => editor.state.tr.insertText(char, from, to)),
    )
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(char, from, to))
  }
}

describe('a wiki link written in the editor', () => {
  it('becomes a link as its brackets close, and saves unescaped', () => {
    const e = empty()
    type(e, 'See [[projects/q2/roadmap.md]]')
    expect(e.getJSON().content?.[0]?.content?.[1]).toMatchObject({
      type: 'wikiLink',
      attrs: { target: 'projects/q2/roadmap.md', label: null },
    })
    expect(e.getMarkdown().trim()).toBe('See [[projects/q2/roadmap.md]]')
  })

  it('keeps a label', () => {
    const e = empty()
    type(e, '[[notes/Ideas|ideas]]')
    expect(e.getMarkdown().trim()).toBe('[[notes/Ideas|ideas]]')
  })

  it('becomes a link when pasted', () => {
    // Paste rules make a ClipboardEvent and a DataTransfer, which jsdom lacks.
    globalThis.ClipboardEvent ??= class extends Event {
      clipboardData = null
    } as unknown as typeof ClipboardEvent
    globalThis.DataTransfer ??= class {
      setData() {}
      getData() {
        return ''
      }
    } as unknown as typeof DataTransfer
    const e = empty()
    e.view.pasteText('Read [[projects/q2/roadmap.md]] first')
    expect(e.getMarkdown().trim()).toBe('Read [[projects/q2/roadmap.md]] first')
    expect(e.getJSON().content?.[0]?.content?.some((n) => n.type === 'wikiLink')).toBe(true)
  })
})
