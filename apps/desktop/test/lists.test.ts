/**
 * Enter in letter lists, which the `alphaLists` parser extension puts in the
 * tree; `test/live-preview.test.ts` covers what counts as one from the
 * rendering side. Then the renumbering of decimal and letter lists, through
 * the real editing commands.
 */
import { deleteCharBackward, history, indentLess, indentMore, undo } from '@codemirror/commands'
import {
  deleteMarkupBackward,
  insertNewlineContinueMarkup,
  markdown,
  markdownLanguage,
} from '@codemirror/lang-markdown'
import { ensureSyntaxTree, indentUnit } from '@codemirror/language'
import {
  EditorSelection,
  EditorState,
  type StateCommand,
  type Transaction,
} from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import {
  alphaLists,
  continueAlphaList,
  markerSwitch,
  renumberOrderedLists,
} from '../src/renderer/src/editor/lists'

/** Runs the command against a doc with `|` marking the caret, and returns the
 *  resulting document, or null when the command declined. */
function enter(docWithCaret: string): string | null {
  const head = docWithCaret.indexOf('|')
  const doc = docWithCaret.replace('|', '')
  let state = EditorState.create({
    doc,
    selection: EditorSelection.single(head),
    extensions: [markdown({ base: markdownLanguage, extensions: alphaLists })],
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

  // Markdown's own Enter builds its indent from the lists it knows, and would
  // put these at the left margin.
  it("continues a list inside a letter item at that item's indent", () => {
    expect(enter('para\n\na. x\n   1. y|')).toBe('para\n\na. x\n   1. y\n   2. ')
    expect(enter('para\n\na. x\n   - y|')).toBe('para\n\na. x\n   - y\n   - ')
    expect(enter('para\n\na. x\n   - [ ] y|')).toBe('para\n\na. x\n   - [ ] y\n   - [ ] ')
  })

  it('steps an empty nested item out to the list around it', () => {
    expect(enter('para\n\na. x\n   1. y\n   2. |')).toBe('para\n\na. x\n   1. y\nb. ')
    expect(enter('1. one\n   a. x\n   b. |')).toBe('1. one\n   a. x\n2. ')
  })

  it("keeps a quote's marker", () => {
    expect(enter('> a. x|')).toBe('> a. x\n> b. ')
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
      extensions: [markdown({ base: markdownLanguage, extensions: alphaLists })],
    })
    expect(continueAlphaList({ state, dispatch: () => {} })).toBe(false)
  })
})

/** Runs a command against a doc with `|` marking the caret (or `|…|` a
 *  selection), with ordered-list renumbering installed, and returns the doc. */
function run(command: StateCommand, docWithCaret: string): string {
  const anchor = docWithCaret.indexOf('|')
  const head = docWithCaret.indexOf('|', anchor + 1)
  const doc = docWithCaret.replaceAll('|', '')
  let state = EditorState.create({
    doc,
    selection:
      head === -1 ? EditorSelection.single(anchor) : EditorSelection.single(anchor, head - 1),
    extensions: [
      markdown({ base: markdownLanguage, extensions: alphaLists }),
      indentUnit.of('    '),
      renumberOrderedLists,
    ],
  })
  ensureSyntaxTree(state, state.doc.length, 5_000)
  command({
    state,
    dispatch: (tr: Transaction) => {
      state = tr.state
    },
  })
  return state.doc.toString()
}

describe('renumberOrderedLists', () => {
  it('starts a sublist made by Tab at 1, and closes the gap it leaves', () => {
    expect(run(indentMore, '1. a\n2. |b\n3. c')).toBe('1. a\n    1. b\n2. c')
  })

  it('adds a tabbed item to the sublist above it', () => {
    expect(run(indentMore, '1. a\n    1. b\n2. |c\n3. d')).toBe('1. a\n    1. b\n    2. c\n2. d')
  })

  // The report this was written for, one Tab at a time.
  it('keeps every level counting on its own', () => {
    let doc = '1. one\n2. two\n3. three\n4. four\n5. five'
    const tab = (line: number) => {
      const lines = doc.split('\n')
      lines[line] = lines[line]!.replace(/(\d)/, '|$1')
      doc = run(indentMore, lines.join('\n'))
    }
    tab(1)
    tab(2)
    tab(3)
    tab(3)
    expect(doc).toBe('1. one\n    1. two\n    2. three\n        1. four\n2. five')
  })

  it('renumbers both lists when Shift+Tab moves an item out', () => {
    expect(run(indentLess, '1. a\n    1. b\n    2. |c\n2. d')).toBe('1. a\n    1. b\n2. c\n3. d')
  })

  it('restarts what an outdented item carries with it', () => {
    expect(run(indentLess, '1. a\n    1. |b\n    2. c\n2. d')).toBe('1. a\n2. b\n    1. c\n3. d')
  })

  it('renumbers after Enter', () => {
    expect(run(insertNewlineContinueMarkup, '1. a|\n2. b\n3. c')).toBe('1. a\n2. \n3. b\n4. c')
  })

  it('renumbers both levels when Enter ends a sublist', () => {
    expect(run(insertNewlineContinueMarkup, '1. a\n    1. b\n    2. c\n    3. |\n2. d')).toBe(
      '1. a\n    1. b\n    2. c\n2. \n3. d',
    )
  })

  it('closes the gap when Backspace takes a marker away', () => {
    expect(run(deleteMarkupBackward, '1. a\n2. |b\n3. c')).toBe('1. a\n   b\n2. c')
  })

  it('closes the gap when an item is deleted', () => {
    expect(run(deleteCharBackward, '1. a\n|2. b\n|3. c')).toBe('1. a\n2. c')
  })

  it('keeps a start the list already had', () => {
    expect(run(indentMore, '5. a\n6. |b\n7. c')).toBe('5. a\n    1. b\n6. c')
    // A blank line above lets a sublist start where it likes.
    expect(run(insertNewlineContinueMarkup, '1. a\n\n    3. b|')).toBe('1. a\n\n    3. b\n    4. ')
  })

  it('fixes a sublist GitHub would read as more of the item above', () => {
    expect(run(insertNewlineContinueMarkup, '1. a\n    2. b|\n2. c')).toBe(
      '1. a\n    1. b\n    2. \n2. c',
    )
  })

  it('keeps the delimiter each item has', () => {
    expect(run(indentMore, '1) a\n2) |b\n3) c')).toBe('1) a\n    1) b\n2) c')
  })

  it('leaves a number the author types alone', () => {
    expect(run(insertText('7'), '1. a\n|2. b')).toBe('1. a\n72. b')
  })

  it('leaves bullets as they are', () => {
    expect(run(indentMore, '- a\n- |b')).toBe('- a\n    - b')
  })

  it('reletters an alphabetic list the same way', () => {
    expect(run(indentMore, 'para\n\na. x\nb. |y\nc. z')).toBe('para\n\na. x\n    a. y\nb. z')
    expect(run(indentLess, 'para\n\na. x\n    a. y\n    b. |z\nb. w')).toBe(
      'para\n\na. x\n    a. y\nb. z\nc. w',
    )
    expect(run(continueAlphaList, 'para\n\na. x|\nb. y')).toBe('para\n\na. x\nb. \nc. y')
  })

  it("keeps an alphabetic list's case and delimiter", () => {
    expect(run(indentMore, 'para\n\nA) x\nB) |y\nC) z')).toBe('para\n\nA) x\n    A) y\nB) z')
  })

  it('nests an alphabetic list under a numbered one, each counting on its own', () => {
    expect(run(indentMore, '1. one\n   a. x\n   b. |y\n2. two')).toBe(
      '1. one\n   a. x\n       a. y\n2. two',
    )
  })
})

/** Types text at the selection, as the keyboard would. */
function insertText(text: string): StateCommand {
  return ({ state, dispatch }) => {
    dispatch(state.update(state.replaceSelection(text), { userEvent: 'input.type' }))
    return true
  }
}

describe('markerSwitch', () => {
  /** Types `text` at the caret one character at a time, as the input handler
   *  sees it, switching the list where it would. Returns the doc, and the
   *  state for undoing. */
  function type(docWithCaret: string, text: string): { doc: string; state: EditorState } {
    const head = docWithCaret.indexOf('|')
    let state = EditorState.create({
      doc: docWithCaret.replace('|', ''),
      selection: EditorSelection.single(head),
      extensions: [
        markdown({ base: markdownLanguage, extensions: alphaLists }),
        history(),
        renumberOrderedLists,
      ],
    })
    for (const ch of text) {
      state = state.update(state.replaceSelection(ch), { userEvent: 'input.type' }).state
      ensureSyntaxTree(state, state.doc.length, 5_000)
      const change = markerSwitch(state, state.selection.main.head, ch)
      if (change !== null) state = state.update(change).state
    }
    return { doc: state.doc.toString(), state }
  }

  it('makes a new sublist a letter list when its first item is typed as one', () => {
    expect(type('1. first bullet\n    1. |', 'a.').doc).toBe('1. first bullet\n    a. ')
  })

  it("keeps a later item its list's kind", () => {
    const doc = '1. first bullet\n    1. first nested bullet\n    2. |'
    expect(type(doc, 'a.').doc).toBe('1. first bullet\n    1. first nested bullet\n    2. a.')
  })

  it('takes the case, delimiter and start that were typed', () => {
    expect(type('1. x\n    1. |', 'A)').doc).toBe('1. x\n    A) ')
    expect(type('1. x\n    1. |', 'c.').doc).toBe('1. x\n    c. ')
  })

  it('switches back to numbers', () => {
    expect(type('1. x\n    a. |', '1.').doc).toBe('1. x\n    1. ')
  })

  it('brings the rest of the list along', () => {
    expect(type('1. x\n    1. |\n    2. y', 'a.').doc).toBe('1. x\n    a. \n    b. y')
  })

  it('leaves an item that has text alone', () => {
    expect(type('1. x\n    1. word |', 'a.').doc).toBe('1. x\n    1. word a.')
  })

  // The item is still empty, so it is still choosing; ⌘Z gives back `1. a.m.`.
  it('lets an empty first item choose again', () => {
    expect(type('1. x\n    1. |', 'a.c.').doc).toBe('1. x\n    c. ')
  })

  it('undoes the switch alone, giving back what was typed', () => {
    const { state } = type('1. x\n    1. |', 'a.')
    let undone = state
    undo({ state, dispatch: (tr: Transaction) => (undone = tr.state) })
    expect(undone.doc.toString()).toBe('1. x\n    1. a.')
  })
})
