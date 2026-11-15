import { Extension, isTextSelection, resolveFocusPosition } from '@tiptap/react'

import { editorActivity } from '@/hooks/use-editor-activity'

/** Tiptap's focus command queues a frame. A parked, connected editor is not a target. */
export const RichTextActivity = Extension.create({
  name: 'richTextActivity',
  // Commands from this extension replace the core focus command, not its callers.
  priority: 0,
  addCommands() {
    return {
      focus:
        (position = null, options = {}) =>
        ({ editor, view, tr, dispatch }) => {
          const activity = editorActivity(editor)
          if (!activity.displayed || editor.isDestroyed) return false
          if ((view.hasFocus() && position === null) || position === false) return true
          if (!dispatch) return true
          if (position !== null || isTextSelection(editor.state.selection)) {
            const selection = resolveFocusPosition(tr.doc, position) ?? editor.state.selection
            if (!editor.state.selection.eq(selection)) tr.setSelection(selection)
            else if (tr.storedMarks) tr.setStoredMarks(tr.storedMarks)
          }
          const current = activity.capture()
          requestAnimationFrame(() => {
            if (!current() || editor.isDestroyed) return
            view.focus()
            if (options.scrollIntoView !== false) editor.commands.scrollIntoView()
          })
          return true
        },
    }
  },
})
