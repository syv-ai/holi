import { TextSelection } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/react'

/**
 * Bring a body that changed on disk (a pull, the agent) into the editor as a
 * co-author's edit, not a replacement of the page.
 *
 * Only the range from the first difference to the last is replaced, so a
 * caret outside it maps through the change and stays on its text; a
 * whole-document replace would leave it at the end. A caret inside that
 * range (edits on both sides of it, or the tidy taking a space just typed
 * under it) goes to the range's start rather than past the new text.
 * `addToHistory: false`, so ⌘Z never undoes someone else's text, and
 * `preventUpdate`, so the reload is not read as an edit to save.
 */
export function applyReload(editor: Editor, body: string): void {
  // `createDocumentExtensions` always includes `DocumentMarkdown`.
  const manager = editor.markdown!
  const current = editor.state.doc
  const next = editor.schema.nodeFromJSON(manager.parse(body))

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

  const tr = editor.state.tr.replace(start, endA, next.slice(start, endB))
  // The ranged replace must land on exactly the file's document; if it ever
  // does not, replace the whole page rather than lose the outside edit.
  if (!tr.doc.eq(next)) {
    editor.commands.setContent(body, { contentType: 'markdown', emitUpdate: false })
    return
  }
  const { head } = editor.state.selection
  if (head >= start && head <= endA) {
    tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(head, -1))))
  }
  tr.setMeta('addToHistory', false).setMeta('preventUpdate', true)
  editor.view.dispatch(tr)
}
