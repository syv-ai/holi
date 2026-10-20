/**
 * A note's headings, for the outline rail (docs/features/editor.md): each
 * ATX or setext heading in the markdown tree, its level, its text without the
 * marks, and where it starts. From the syntax tree, never a regex over lines,
 * so a `#` inside a code fence or the frontmatter is not a heading.
 */
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'

export interface OutlineHeading {
  level: number
  text: string
  /** The heading line's start. */
  from: number
}

const LEVEL = /^(?:ATXHeading|SetextHeading)(\d)$/

/** How long to wait on the parser before settling for what it has. */
const PARSE_BUDGET_MS = 50

export function outlineOf(state: EditorState): OutlineHeading[] {
  const tree = ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET_MS) ?? syntaxTree(state)
  const out: OutlineHeading[] = []
  tree.iterate({
    enter: (node) => {
      const m = LEVEL.exec(node.name)
      if (m === null) return
      const line = state.doc.lineAt(node.from)
      const raw = node.name.startsWith('Setext')
        ? line.text
        : state.doc.sliceString(node.from, node.to)
      const text = raw
        .replace(/^#{1,6}\s*/, '')
        .replace(/\s+#+\s*$/, '')
        .replace(/[*_`~]|\[\[|\]\]/g, '')
        .trim()
      if (text !== '') out.push({ level: Number(m[1]), text, from: line.from })
      return false
    },
  })
  return out
}

/** The heading whose section holds `pos`: the last one starting at or before it. */
export function currentHeading(headings: readonly OutlineHeading[], pos: number): number {
  let at = -1
  for (let i = 0; i < headings.length && headings[i]!.from <= pos; i++) at = i
  return at
}
