/**
 * Typed arrows become their glyphs: ` -> ` is written into the file as ` → `,
 * and `<-`, `<->` and `=>` likewise. The file holds the glyph, so it reads the
 * same outside Holi.
 */
import { isolateHistory } from '@codemirror/commands'
import { syntaxTree } from '@codemirror/language'
import type { EditorState, TransactionSpec } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import { EditorView } from '@codemirror/view'
import { frontmatterRegion } from './frontmatter-region'

/** Longest first, so `<->` is not read as `->` after a stray `<`. */
const ARROWS: ReadonlyArray<readonly [string, string]> = [
  ['<->', '↔'],
  ['->', '→'],
  ['<-', '←'],
  ['=>', '⇒'],
]

/** Where an arrow is text the author means literally. */
const CODE_NODES = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'CodeText'])

/**
 * Given the state just after `typed` went in, ending at `pos`: the arrow before
 * it rewritten, or null.
 *
 * Only once the space after the arrow is typed, and only when whitespace or the
 * start of the line comes before it, so `a->b`, `==>` and `<!--` stay as they
 * are. Never in code, a code span still being typed included (an odd number of
 * backticks before it on the line), nor in frontmatter.
 */
export function arrowAfterTyping(
  state: EditorState,
  pos: number,
  typed: string,
): TransactionSpec | null {
  if (typed !== ' ') return null
  const line = state.doc.lineAt(pos)
  const before = state.sliceDoc(line.from, pos - 1)
  const hit = ARROWS.find(([arrow]) => before.endsWith(arrow))
  if (hit === undefined) return null
  const [arrow, glyph] = hit
  const from = pos - 1 - arrow.length
  if (from > line.from && !/\s/.test(state.sliceDoc(from - 1, from))) return null
  if (from < (frontmatterRegion(state.doc.toString())?.to ?? 0)) return null
  if ((state.sliceDoc(line.from, from).match(/`/g)?.length ?? 0) % 2 === 1) return null
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(from, 1);
    node;
    node = node.parent
  ) {
    if (CODE_NODES.has(node.name)) return null
  }
  return {
    changes: { from, to: from + arrow.length, insert: glyph },
    // Its own undo step, after the typing: one ⌘Z gives back the typed arrow.
    annotations: isolateHistory.of('before'),
    userEvent: 'input.arrow',
  }
}

/** Types the space first, then rewrites the arrow, as two transactions. */
export const arrowsByTyping = EditorView.inputHandler.of((view, from, to, text, insert) => {
  if (from !== to || view.state.selection.ranges.length > 1) return false
  const typed = insert()
  const change = arrowAfterTyping(typed.state, from + text.length, text)
  if (change === null) return false
  view.dispatch(typed)
  view.dispatch(view.state.update(change))
  return true
})
