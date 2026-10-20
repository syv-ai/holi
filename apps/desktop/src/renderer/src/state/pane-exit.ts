/**
 * Closing panes and tabs, as atoms, so a key, the menu and the palette all
 * close the same way.
 *
 * **A close lands at once.** Closing a split's pane used to wait for an exit
 * animation; ⌘W is a keyboard action, nothing animates a pane opening, and an
 * exit only the closing side has reads as lag rather than as a place
 * (docs/ui-system.md, Motion).
 */
import { atom } from 'jotai'
import { closePane, closeTab, focusPane, workspaceAtom } from './panes'

export const closePaneAtom = atom(null, (_get, set, index: number): void => {
  set(workspaceAtom, (w) => closePane(w, index))
})

/** Close one tab; closing a split pane's last tab takes the pane too
 *  (`closeTab`). A plugin that must hear its tab closed watches
 *  `surfaceTabIdsAtom`. */
export const closeTabAtom = atom(null, (_get, set, paneIndex: number, tabIndex: number): void => {
  set(workspaceAtom, (w) => closeTab(focusPane(w, paneIndex), tabIndex))
})

/**
 * ⌘W: the focused pane's active tab. With a single pane the last tab leaves
 * it empty; with nothing open at all, `closeTab` at `-1` is a no-op. An EMPTY
 * pane in a split does go, which is what ⌘\ then ⌘W should do.
 */
export const closeActiveTabAtom = atom(null, (get, set): void => {
  const w = get(workspaceAtom)
  const focused = w.panes[w.active]
  if (focused === undefined) return
  set(closeTabAtom, w.active, focused.active)
})
