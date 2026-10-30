import type { Node, ResolvedPos } from '@tiptap/pm/model'
import { Selection, TextSelection } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/react'

/**
 * Bring a body that changed on disk (a pull, the agent) into the editor as a
 * co-author's edit, not a replacement of the page.
 *
 * Only the range from the first difference to the last is replaced, so a
 * selection outside it maps through the change and stays on its text; a
 * whole-document replace would leave it at the end. An end inside that range
 * (edits on both sides of it, or the tidy taking a space just typed under it)
 * goes to the range's start rather than past the new text, and a range
 * selection stays a range. `addToHistory: false`, so ⌘Z never undoes someone
 * else's text, and `preventUpdate`, so the reload is not read as an edit to
 * save.
 */
export function applyReload(editor: Editor, body: string): void {
  // `createDocumentExtensions` always includes `DocumentMarkdown`.
  const manager = editor.markdown!
  const current = editor.state.doc
  const next = withTrailingParagraph(editor, editor.schema.nodeFromJSON(manager.parse(body)))

  const start = current.content.findDiffStart(next.content)
  if (start === null) return
  let { a: endA, b: endB } = current.content.findDiffEnd(next.content)!
  // Where the change repeats text around it, the two scans overlap: move the
  // ends past the start so neither range is negative.
  const overlap = start - Math.min(endA, endB)
  if (overlap > 0) {
    endA += overlap
    endB += overlap
  }

  const { anchor, head } = editor.state.selection
  let tr = editor.state.tr.replace(start, endA, next.slice(start, endB))
  if (tr.doc.eq(next)) {
    // An end inside the replaced range goes to its start; outside it, the
    // transaction's own mapping keeps it on its text.
    const inside = (pos: number) => pos >= start && pos <= endA
    if (inside(anchor) || inside(head)) {
      const map = (pos: number) => tr.doc.resolve(inside(pos) ? start : tr.mapping.map(pos))
      tr.setSelection(between(map(anchor), map(head)))
    }
  } else {
    // The ranged replace must land on exactly the file's document; if it ever
    // does not, replace the whole page rather than lose the outside edit,
    // still outside the undo history, and keep the selection where it was as
    // far as the new page reaches.
    tr = editor.state.tr.replaceWith(0, current.content.size, next.content)
    const clamp = (pos: number) => tr.doc.resolve(Math.min(pos, tr.doc.content.size))
    tr.setSelection(between(clamp(anchor), clamp(head)))
  }
  tr.setMeta('addToHistory', false).setMeta('preventUpdate', true)
  editor.view.dispatch(tr)
}

function between($anchor: ResolvedPos, $head: ResolvedPos): Selection {
  if ($anchor.pos === $head.pos) return TextSelection.near($head)
  return TextSelection.between($anchor, $head) ?? Selection.near($head)
}

/**
 * StarterKit's trailing-node rule keeps an empty paragraph after a last block
 * that is not one, and the parsed file has none; without it the two documents
 * always differ at the end, so the diff runs to the end of the page and an
 * unchanged file ending in a list is still an edit.
 */
function withTrailingParagraph(editor: Editor, doc: Node): Node {
  const paragraph = editor.schema.nodes.paragraph!
  if (doc.lastChild?.type === paragraph) return doc
  return doc.copy(doc.content.addToEnd(paragraph.create()))
}
