/**
 * Alphabetic list continuation. The predicate that decides what counts as one
 * is shared with live preview, so `test/live-preview.test.ts` covers the same
 * rules from the rendering side; these are about what Enter writes.
 */
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, type Transaction } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { continueAlphaList } from '../src/renderer/src/editor/lists'

/** Runs the command against a doc with `|` marking the caret, and returns the
 *  resulting document, or null when the command declined. */
function enter(docWithCaret: string): string | null {
  const head = docWithCaret.indexOf('|')
  const doc = docWithCaret.replace('|', '')
  let state = EditorState.create({
    doc,
    selection: EditorSelection.single(head),
    extensions: [markdown({ base: markdownLanguage })],
  })
  ensureSyntaxTree(state, state.doc.length, 5_000)
  let ran = false
  const handled = continueAlphaList({
    state,
    dispatch: (tr: Transaction) => {
      ran = true
      state = tr.state
    },
  })
  return handled && ran ? state.doc.toString() : null
}

describe('continueAlphaList', () => {
  it('writes the next letter', () => {
    expect(enter('para\n\na. first|')).toBe('para\n\na. first\nb. ')
  })

  it('keeps the indent, so a nested list stays nested', () => {
    expect(enter('1. one\n   a. sub|')).toBe('1. one\n   a. sub\n   b. ')
  })

  it('keeps the delimiter it was given', () => {
    expect(enter('para\n\na) first|')).toBe('para\n\na) first\nb) ')
  })

  it('follows the case it was given', () => {
    expect(enter('para\n\nA. first|')).toBe('para\n\nA. first\nB. ')
  })

  it('splits the line when the caret is inside it', () => {
    expect(enter('para\n\na. one|two')).toBe('para\n\na. one\nb. two')
  })

  // The same bargain markdown's own Enter strikes: a second press gets you out.
  it('ends the list on an empty item', () => {
    expect(enter('para\n\na. first\nb. |')).toBe('para\n\na. first\n')
  })

  it('has nowhere to go past z, and repeats rather than writing punctuation', () => {
    expect(enter('para\n\nz. last|')).toBe('para\n\nz. last\nz. ')
  })

  it('declines on a line that is not one of these', () => {
    expect(enter('para\n\njust prose|')).toBeNull()
    expect(enter('para\n\n- a bullet|')).toBeNull()
    // Mid-paragraph, where "A. Smith said" is a sentence.
    expect(enter('Someone wrote it.\nA. Smith said so|')).toBeNull()
  })

  it('declines inside the marker itself', () => {
    expect(enter('para\n\na|. first')).toBeNull()
  })

  it('declines on a selection, which Enter should replace', () => {
    const doc = 'para\n\na. first'
    const state = EditorState.create({
      doc,
      selection: EditorSelection.single(6, 10),
      extensions: [markdown({ base: markdownLanguage })],
    })
    expect(continueAlphaList({ state, dispatch: () => {} })).toBe(false)
  })
})
