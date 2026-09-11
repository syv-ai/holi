/**
 * "Show me this task", from wherever you are.
 *
 * All that is left of a module that used to hold `viewAtom` — a two-surface
 * switch the pane system replaced (notes-editor.md §Panes & tabs). `viewAtom`,
 * `MainView` and `openDocAtom` went with the detail panel: nothing had read them
 * since panes landed, and a task no longer has a surface of its own to be shown
 * on. It has a file, and opening it is opening that.
 *
 * **Pinned rather than a preview.** A reminder you clicked and a task you asked
 * to flesh out are both deliberate arrivals, not browsing, and a preview tab
 * would be replaced by the next thing you glanced at.
 */
import { atom } from 'jotai'
import { openPinned, workspaceAtom } from './panes'

/** The path is the task's identity — there are no opaque task ids to resolve
 *  (glossary §Task), so this is the same opener a note gets. */
export const openTaskAtom = atom(null, (_get, set, path: string) => {
  set(workspaceAtom, (w) => openPinned(w, path))
})
