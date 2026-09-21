/**
 * A pane on its way out of a split.
 *
 * React unmounts the instant state says the pane is gone, so an exit written
 * as a class on a pane that has already been removed never runs. The change is
 * held for exactly as long as the animation takes, read off `--motion-leave`
 * so the wait and the CSS cannot drift, and the pane is marked `leaving`
 * meanwhile. Under reduced motion there is nothing to wait for.
 *
 * **Both ways out of a split come through here.** The close-pane button is the
 * obvious one; closing the LAST TAB of a pane also unsplits, and that is the
 * one people actually do — an exit only the button played would look broken
 * more often than it looked right.
 *
 * State rather than Shell's own `useState` (D102): a command table has to be
 * able to close a tab from a key, the menu and the palette alike, and a
 * component-local timer is reachable from none of them.
 */
import { atom } from 'jotai'
import { motionDurationMs, prefersReducedMotion } from '../lib/motion'
import {
  closePane,
  closeTab,
  closingTabRemovesPane,
  focusPane,
  workspaceAtom,
  type Workspace,
} from './panes'

/** Index of the pane playing its exit, or null. Shell reads it per pane. */
export const leavingPaneAtom = atom<number | null>(null)

/** Module-level rather than in the atom: there is one Shell for the app's
 *  lifetime, and a second close before the first has landed replaces the
 *  timer rather than letting two of them fire and take two panes. */
let leaveTimer: ReturnType<typeof setTimeout> | null = null

const leaveThenApplyAtom = atom(
  null,
  (_get, set, index: number, apply: (w: Workspace) => Workspace): void => {
    if (prefersReducedMotion()) {
      set(workspaceAtom, apply)
      return
    }
    if (leaveTimer !== null) clearTimeout(leaveTimer)
    set(leavingPaneAtom, index)
    leaveTimer = setTimeout(
      () => {
        leaveTimer = null
        set(workspaceAtom, apply)
        set(leavingPaneAtom, null)
      },
      motionDurationMs('--motion-leave', 190),
    )
  },
)

export const closePaneWithExitAtom = atom(null, (_get, set, index: number): void => {
  set(leaveThenApplyAtom, index, (w) => closePane(w, index))
})

/**
 * Close one tab. Only the close that EMPTIES a pane is an exit. Every other
 * tab close is just a tab going, and holding those back by 190ms would make
 * the strip feel slow for the common case.
 */
export const closeTabWithExitAtom = atom(
  null,
  (get, set, paneIndex: number, tabIndex: number): void => {
    const apply = (w: Workspace): Workspace => closeTab(focusPane(w, paneIndex), tabIndex)
    if (closingTabRemovesPane(focusPane(get(workspaceAtom), paneIndex), tabIndex)) {
      set(leaveThenApplyAtom, paneIndex, apply)
      return
    }
    set(workspaceAtom, apply)
  },
)

/**
 * ⌘W: the focused pane's active tab. With a single pane the last tab leaves
 * it empty; with nothing open at all, `closeTab` at `-1` is a no-op. An EMPTY
 * pane in a split does go, which is what ⌘\ then ⌘W should do.
 */
export const closeActiveTabWithExitAtom = atom(null, (get, set): void => {
  const w = get(workspaceAtom)
  const focused = w.panes[w.active]
  if (focused === undefined) return
  set(closeTabWithExitAtom, w.active, focused.active)
})
