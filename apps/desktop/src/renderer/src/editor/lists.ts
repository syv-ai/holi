/**
 * Alphabetic ordered lists: `a.`, `A.`, `a)`. CommonMark's ordered list is
 * decimal only, so the tree has nothing for these. Live preview and Enter both
 * go through the one predicate here, so they cannot disagree.
 */
import { syntaxTree } from '@codemirror/language'
import { EditorSelection, Prec, type EditorState, type Line, type StateCommand } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'

const ALPHA_MARKER = /^([ \t]*)([A-Za-z])([.)])[ \t]/

export interface AlphaListItem {
  /** The whitespace the line opens with, so a continuation lands under it. */
  indent: string
  /** `a`, `A`, `z`… */
  letter: string
  /** `.` or `)`. */
  delim: string
  /** Where the marker starts, past the indent. */
  markFrom: number
  /** Just past the marker, before the space that follows it. */
  markTo: number
  /** Nesting level, counting the lists this line sits inside. */
  depth: number
}

/**
 * The alphabetic list item this line is, or null. Deliberately fussy: the line
 * must sit inside a list already (`a.` under `1.`) or begin a block, markdown's
 * rule for an ordered list interrupting a paragraph. So "A. Smith said" stays
 * a sentence, and `a) hello` inside a fence stays code.
 */
export function alphaListAt(state: EditorState, line: Line): AlphaListItem | null {
  const m = ALPHA_MARKER.exec(line.text)
  if (m === null) return null
  const indent = m[1]!
  const markFrom = line.from + indent.length

  let depth = 0
  let fenced = false
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(markFrom, 1);
    node !== null;
    node = node.parent
  ) {
    if (node.name === 'BulletList' || node.name === 'OrderedList') depth++
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') fenced = true
  }
  if (fenced) return null
  // "Begins a block" is a property of the whole run: walk back over markers at
  // this indent and ask it of the run's first line.
  let first = line.number
  while (first > 1) {
    const above = state.doc.line(first - 1)
    const aboveMatch = ALPHA_MARKER.exec(above.text)
    if (aboveMatch === null || aboveMatch[1] !== indent) break
    first--
  }
  const startsBlock = first === 1 || state.doc.line(first - 1).text.trim() === ''
  if (depth === 0 && !startsBlock) return null

  return {
    indent,
    letter: m[2]!,
    delim: m[3]!,
    markFrom,
    markTo: markFrom + 2,
    // The lists around it, plus this one.
    depth: depth + 1,
  }
}

/** `a` → `b`. The end of the alphabet has nowhere to go, and repeating the
 *  letter beats emitting `{`. */
function nextLetter(letter: string): string {
  if (letter === 'z' || letter === 'Z') return letter
  return String.fromCharCode(letter.charCodeAt(0) + 1)
}

/**
 * Enter on an alphabetic list line writes the next letter, as
 * `insertNewlineContinueMarkup` does for parsed lists. An empty item ends the
 * list instead.
 */
export const continueAlphaList: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main
  if (!range.empty) return false
  const line = state.doc.lineAt(range.head)
  const item = alphaListAt(state, line)
  // Inside the marker itself, Enter is just Enter.
  if (item === null || range.head <= item.markTo) return false

  if (state.sliceDoc(item.markTo, line.to).trim() === '') {
    dispatch(
      state.update(
        { changes: { from: line.from, to: line.to } },
        { scrollIntoView: true, userEvent: 'delete' },
      ),
    )
    return true
  }

  const insert = `\n${item.indent}${nextLetter(item.letter)}${item.delim} `
  dispatch(
    state.update(
      {
        changes: { from: range.head, insert },
        selection: EditorSelection.cursor(range.head + insert.length),
      },
      { scrollIntoView: true, userEvent: 'input' },
    ),
  )
  return true
}

/** High precedence, before the markdown keymap's Enter; it declines elsewhere. */
export const alphaListKeymap = Prec.high(keymap.of([{ key: 'Enter', run: continueAlphaList }]))
