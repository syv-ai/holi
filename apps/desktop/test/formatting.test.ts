import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { toggleInline, toggleLink } from '../src/renderer/src/editor/formatting'

function state(doc: string, anchor: number, head = anchor) {
  return EditorState.create({ doc, selection: EditorSelection.single(anchor, head) })
}

function apply(s: EditorState, spec: ReturnType<typeof toggleInline>) {
  if (!spec) throw new Error('expected a transaction spec')
  return s.update(spec).state
}

describe('toggleInline (FR-3: toggle-aware wrap/unwrap)', () => {
  it('wraps a selection in ** and places the selection inside', () => {
    const next = apply(state('hello world', 0, 5), toggleInline(state('hello world', 0, 5), '**'))
    expect(next.doc.toString()).toBe('**hello** world')
    expect(next.sliceDoc(next.selection.main.from, next.selection.main.to)).toBe('hello')
  })

  it('unwraps when the selection is already surrounded', () => {
    const s = state('**hello** world', 2, 7) // selection = hello
    const next = apply(s, toggleInline(s, '**'))
    expect(next.doc.toString()).toBe('hello world')
  })

  it('unwraps when the selection includes the markers', () => {
    const s = state('**hello** world', 0, 9)
    const next = apply(s, toggleInline(s, '**'))
    expect(next.doc.toString()).toBe('hello world')
  })

  it('expands an empty selection to the word under the caret', () => {
    const s = state('hello world', 2)
    const next = apply(s, toggleInline(s, '*'))
    expect(next.doc.toString()).toBe('*hello* world')
  })

  it('returns null on an empty selection not inside a word', () => {
    expect(toggleInline(state('a  b', 2), '*')).toBeNull()
  })
})

describe('toggleLink (⌘K)', () => {
  it('wraps the selection as [sel](url) with the url selected', () => {
    const s = state('see docs here', 4, 8)
    const next = apply(s, toggleLink(s))
    expect(next.doc.toString()).toBe('see [docs](url) here')
    expect(next.sliceDoc(next.selection.main.from, next.selection.main.to)).toBe('url')
  })
})
