/**
 * Typed arrows: ` -> ` becomes ` → ` when the space after it goes in, and one
 * ⌘Z gives the typed arrow back.
 */
import { history, undo } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, type Transaction } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { arrowAfterTyping } from '../src/renderer/src/editor/arrows'
import { alphaLists } from '../src/renderer/src/editor/lists'

/** Types `text` at the caret (`|`) one character at a time, as the input
 *  handler sees it. Returns the doc, and the state for undoing. */
function type(docWithCaret: string, text: string): { doc: string; state: EditorState } {
  const head = docWithCaret.indexOf('|')
  let state = EditorState.create({
    doc: docWithCaret.replace('|', ''),
    selection: EditorSelection.single(head),
    extensions: [markdown({ base: markdownLanguage, extensions: alphaLists }), history()],
  })
  for (const ch of text) {
    state = state.update(state.replaceSelection(ch), { userEvent: 'input.type' }).state
    ensureSyntaxTree(state, state.doc.length, 5_000)
    const change = arrowAfterTyping(state, state.selection.main.head, ch)
    if (change !== null) state = state.update(change).state
  }
  return { doc: state.doc.toString(), state }
}

describe('arrowAfterTyping', () => {
  it('turns each arrow into its glyph once the space after it is typed', () => {
    expect(type('a|', ' -> b').doc).toBe('a → b')
    expect(type('a|', ' <- b').doc).toBe('a ← b')
    expect(type('a|', ' <-> b').doc).toBe('a ↔ b')
    expect(type('a|', ' => b').doc).toBe('a ⇒ b')
  })

  it('waits for the space: an arrow at the end of what was typed stays', () => {
    expect(type('a|', ' ->').doc).toBe('a ->')
  })

  it('counts the start of a line as whitespace', () => {
    expect(type('|', '-> next').doc).toBe('→ next')
  })

  it('leaves an arrow touching other text alone', () => {
    expect(type('a|', '-> b').doc).toBe('a-> b')
    expect(type('a|', ' ==> b').doc).toBe('a ==> b')
    expect(type('a|', ' <!-- b').doc).toBe('a <!-- b')
  })

  it('leaves code alone', () => {
    expect(type('`a|`', ' -> b').doc).toBe('`a -> b`')
    expect(type('```\na|\n```', ' -> b').doc).toBe('```\na -> b\n```')
    expect(type('text\n\n    a|', ' -> b').doc).toBe('text\n\n    a -> b')
  })

  it('leaves an inline code span that is still open alone', () => {
    expect(type('see `a|', ' -> b').doc).toBe('see `a -> b')
  })

  it('works after a closed code span', () => {
    expect(type('`x` a|', ' -> b').doc).toBe('`x` a → b')
  })

  it('works in a list item', () => {
    expect(type('- a|', ' -> b').doc).toBe('- a → b')
  })

  it('undoes the arrow alone, giving back what was typed', () => {
    const { state } = type('a|', ' -> ')
    expect(state.doc.toString()).toBe('a → ')
    let undone = state
    undo({ state, dispatch: (tr: Transaction) => (undone = tr.state) })
    expect(undone.doc.toString()).toBe('a -> ')
  })
})
