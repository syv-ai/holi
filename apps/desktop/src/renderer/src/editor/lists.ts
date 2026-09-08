/**
 * Alphabetic ordered lists: `a.`, `A.`, `a)`.
 *
 * CommonMark's ordered list is decimal only, so the parser reads these as an
 * ordinary paragraph and the syntax tree has nothing to say about them. Live
 * preview has to find them by reading lines, and Enter has to continue them by
 * hand for the same reason. Both go through the one predicate here, so what
 * renders as a list and what continues as one cannot come to disagree.
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
 * The alphabetic list item this line is, or null.
 *
 * Deliberately fussy, because a marker the parser does not know is a marker
 * this file has to judge for itself. The line has to either sit inside a list
 * already — `a.` under `1.`, which is what these are nearly always for — or
 * begin a block, which is the same rule markdown puts on an ordered list
 * interrupting a paragraph. So a paragraph opening "A. Smith said" stays a
 * sentence, and `a) hello` inside a fence stays code.
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
  // "Begins a block" is a property of the whole run, not of this line: the
  // second item of a list is preceded by the first, not by a blank. So walk back
  // over the markers at this indent and ask the question of the run's first
  // line. A run that starts mid-paragraph is prose all the way down.
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
 * Enter on an alphabetic list line writes the next letter.
 *
 * `markdown()` installs `insertNewlineContinueMarkup`, which does this for every
 * list the parser knows and cannot do it for the one it does not. An empty item
 * ends the list instead of continuing it, which is the same bargain that keymap
 * strikes: the second Enter is how you get out.
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

/** High precedence, so it is asked before the markdown keymap's own Enter. It
 *  declines on every line that is not one of these, so nothing else changes. */
export const alphaListKeymap = Prec.high(keymap.of([{ key: 'Enter', run: continueAlphaList }]))
