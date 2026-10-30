import type { EditorState, Transaction } from '@tiptap/pm/state'
import type { Node } from '@tiptap/pm/model'

/** Replace only the changed range of a disk snapshot, without making it an undo step. */
export function applyReload(state: EditorState, incoming: Node): Transaction | null {
  const start = state.doc.content.findDiffStart(incoming.content)
  if (start === null) return null

  const end = state.doc.content.findDiffEnd(incoming.content)
  if (end === null) return null

  return state.tr
    .replace(start, end.a, incoming.slice(start, end.b))
    .setMeta('addToHistory', false)
}
