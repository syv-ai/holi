import type { Editor } from '@tiptap/react'

/**
 * Bring a body that changed on disk (a pull, the agent) into the editor as a
 * co-author's edit, not a replacement of the page.
 *
 * Only the range from the first difference to the last is replaced, so a
 * caret outside it maps through the change and stays on its text; a
 * whole-document replace would leave it at the end. Edits on both sides of
 * the caret put it inside that range, and it moves. `addToHistory: false`, so
 * ⌘Z never undoes someone else's text, and `preventUpdate`, so the reload is
 * not read as an edit to save.
 */
export function applyReload(editor: Editor, body: string): void {
  const manager = editor.markdown
  if (!manager) {
    editor.commands.setContent(body, { contentType: 'markdown', emitUpdate: false })
    return
  }
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
  tr.setMeta('addToHistory', false).setMeta('preventUpdate', true)
  editor.view.dispatch(tr)
}
