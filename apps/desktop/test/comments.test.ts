/**
 * An HTML comment on lines of its own draws as a banner, and shows its source
 * when the selection touches it.
 */
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { commentDecorations, commentText } from '../src/renderer/src/editor/comments'
import { alphaLists } from '../src/renderer/src/editor/lists'

function banners(doc: string, caret = 0): { from: number; to: number; text: string }[] {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(caret),
    extensions: [markdown({ base: markdownLanguage, extensions: alphaLists })],
  })
  ensureSyntaxTree(state, state.doc.length, 5_000)
  const out: { from: number; to: number; text: string }[] = []
  const iter = commentDecorations(state).iter()
  while (iter.value) {
    const widget = iter.value.spec.widget as { text: string }
    out.push({ from: iter.from, to: iter.to, text: widget.text })
    iter.next()
  }
  return out
}

describe('commentText', () => {
  it('drops the markers and the space inside them', () => {
    expect(commentText('<!-- a note -->')).toBe('a note')
  })

  it('keeps the lines of a long comment, less their shared indent', () => {
    expect(commentText('<!--\n  first\n    second\n-->')).toBe('first\n  second')
  })
})

describe('commentDecorations', () => {
  it('draws a comment on its own lines as a banner', () => {
    const doc = 'text\n\n<!-- one -->\n\nmore'
    expect(banners(doc)).toEqual([{ from: 6, to: 18, text: 'one' }])
  })

  it('covers every line of a multi-line comment', () => {
    const doc = 'text\n\n<!--\nfirst\nsecond\n-->\n'
    expect(banners(doc)).toEqual([{ from: 6, to: doc.length - 1, text: 'first\nsecond' }])
  })

  it('shows the source while the selection touches it', () => {
    const doc = 'text\n\n<!-- one -->\n\nmore'
    expect(banners(doc, doc.indexOf('one'))).toEqual([])
  })

  it('leaves a comment inside a paragraph to the text', () => {
    expect(banners('text <!-- aside --> more\n\nnext')).toEqual([])
  })

  it('leaves an empty comment as source', () => {
    expect(banners('text\n\n<!-- -->\n')).toEqual([])
  })
})
