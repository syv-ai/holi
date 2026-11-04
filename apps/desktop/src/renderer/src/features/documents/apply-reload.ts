import type { Node, ResolvedPos } from '@tiptap/pm/model'
import { Selection, TextSelection } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/react'

/** Apply a disk snapshot as an external edit, never as a local edit to save or undo. */
export function applyReload(editor: Editor, body: string): boolean {
  const manager = editor.markdown
  if (!manager) throw new Error('The document editor has no markdown parser')

  const current = editor.state.doc
  const parsed = editor.schema.nodeFromJSON(manager.parse(body))
  const next = withEmptyEnd(current, withTrailingParagraph(editor, parsed))
  const start = current.content.findDiffStart(next.content)
  if (start === null) return false

  let { a: endA, b: endB } = current.content.findDiffEnd(next.content)!
  const overlap = start - Math.min(endA, endB)
  if (overlap > 0) {
    endA += overlap
    endB += overlap
  }

  const { anchor, head } = editor.state.selection
  let transaction = editor.state.tr.replace(start, endA, next.slice(start, endB))
  if (transaction.doc.eq(next)) {
    const inside = (pos: number) => pos >= start && pos <= endA
    if (inside(anchor) || inside(head)) {
      const map = (pos: number) =>
        transaction.doc.resolve(inside(pos) ? start : transaction.mapping.map(pos))
      transaction.setSelection(between(map(anchor), map(head)))
    }
  } else {
    transaction = editor.state.tr.replaceWith(0, current.content.size, next.content)
    const clamp = (pos: number) =>
      transaction.doc.resolve(Math.min(pos, transaction.doc.content.size))
    transaction.setSelection(between(clamp(anchor), clamp(head)))
  }

  transaction.setMeta('addToHistory', false).setMeta('preventUpdate', true)
  editor.view.dispatch(transaction)
  return true
}

function between(anchor: ResolvedPos, head: ResolvedPos): Selection {
  if (anchor.pos === head.pos) return TextSelection.near(head)
  return TextSelection.between(anchor, head) ?? Selection.near(head)
}

function withTrailingParagraph(editor: Editor, doc: Node): Node {
  const paragraph = editor.schema.nodes.paragraph!
  return doc.lastChild?.type === paragraph
    ? doc
    : doc.copy(doc.content.addToEnd(paragraph.create()))
}

function withEmptyEnd(current: Node, next: Node): Node {
  const missing = emptyEnd(current) - emptyEnd(next)
  if (missing <= 0) return next
  const paragraph = current.lastChild!.type
  let content = next.content
  for (let i = 0; i < missing; i++) content = content.addToEnd(paragraph.create())
  return next.copy(content)
}

function emptyEnd(doc: Node): number {
  let count = 0
  while (count < doc.childCount) {
    const child = doc.child(doc.childCount - 1 - count)
    if (child.type.name !== 'paragraph' || child.content.size > 0) break
    count++
  }
  return count
}
