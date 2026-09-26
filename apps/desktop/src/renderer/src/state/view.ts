/**
 * "Show me this task", from wherever you are. A task has no surface of its own:
 * it has a file, and opening it is opening that.
 *
 * **Pinned rather than a preview.** A reminder you clicked and a task you asked
 * to flesh out are both deliberate arrivals, not browsing, and a preview tab
 * would be replaced by the next thing you glanced at.
 */
import { atom } from 'jotai'
import { openPinned, workspaceAtom } from './panes'

/** The path is the task's identity (glossary §Task), so this is the same opener
 *  a note gets. */
export const openTaskAtom = atom(null, (_get, set, path: string) => {
  set(workspaceAtom, (w) => openPinned(w, path))
})
