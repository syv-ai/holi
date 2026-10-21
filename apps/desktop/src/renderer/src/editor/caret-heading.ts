/**
 * The heading the caret is on, for "Copy Holi link to this heading"
 * (docs/features/holi-links.md). Only a caret on the heading's own line counts:
 * a link names the heading you are pointing at, not the section you are in.
 */
import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'

/** A closing run of hashes is decoration, as in `@holi/shared`'s headings. */
const ATX = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/

/** The words of the ATX heading under an empty caret, or null. The syntax tree
 *  says whether the line is a heading, so a `#` in a code block is not. */
export function caretHeading(state: EditorState): string | null {
  const range = state.selection.main
  if (!range.empty) return null
  const line = state.doc.lineAt(range.head)
  const match = ATX.exec(line.text)
  if (match === null || match[1]!.trim() === '') return null
  for (let node = syntaxTree(state).resolveInner(line.from, 1); node.parent; node = node.parent) {
    if (node.name.startsWith('ATXHeading')) return match[1]!.trim()
  }
  return null
}
