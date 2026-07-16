/**
 * Which surface the main pane shows.
 *
 * An atom rather than `useState` in `Shell` because opening a doc is not the Shell's
 * decision: the file tree (and, later, a shortcut or the agent) opens a note while the
 * board is on screen, and the pane has to follow. Held in `Shell`'s local state, `view`
 * was unreachable from those callers, so a tree click set `activeDoc` and nothing moved —
 * the board just sat there.
 *
 * Deliberately not a router: the shell is single-window with two surfaces. When the pane
 * system lands (notes-editor §Panes & tabs) this is what it grows into.
 */
import { atom } from 'jotai'
import type { DocMeta } from '@holi/shared'
import { activeDocAtom } from './vaults'

export type MainView = 'notes' | 'board'

export const viewAtom = atom<MainView>('notes')

/** Open a doc in the editor, wherever you are. The one way to open a note — it moves the
 * pane to `notes` as well as setting the doc, so no caller can set one and forget the
 * other. */
export const openDocAtom = atom(null, (_get, set, doc: DocMeta) => {
  set(activeDocAtom, doc)
  set(viewAtom, 'notes')
})
