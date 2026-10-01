/**
 * A pane on its way out of a split.
 *
 * React unmounts the instant state says the pane is gone, so an exit written
 * as a class on a pane that has already been removed never runs. The change is
 * held for exactly as long as the animation takes, read off `--motion-leave`
 * so the wait and the CSS cannot drift, and the pane is marked `leaving`
 * meanwhile. Under reduced motion there is nothing to wait for.
 *
 * **Both ways out of a split come through here**: the close-pane button, and
 * closing the LAST TAB of a pane, which is the one people actually do.
 *
 * State rather than Shell's own `useState`: a command closes a tab from
 * a key, the menu and the palette alike, none of which reach a component timer.
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

/** Apply a close. A plugin that must hear its tab closed watches
 *  `surfaceTabIdsAtom`. */
const applyClosingAtom = atom(null, (_get, set, apply: (w: Workspace) => Workspace): void => {
  set(workspaceAtom, apply)
})

const leaveThenApplyAtom = atom(
  null,
  (_get, set, index: number, apply: (w: Workspace) => Workspace): void => {
    if (prefersReducedMotion()) {
      set(applyClosingAtom, apply)
      return
    }
    if (leaveTimer !== null) clearTimeout(leaveTimer)
    set(leavingPaneAtom, index)
    leaveTimer = setTimeout(
      () => {
        leaveTimer = null
        set(applyClosingAtom, apply)
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
    set(applyClosingAtom, apply)
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
