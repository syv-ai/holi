import {
  entriesByRecency,
  entryId,
  entryOf,
  focusMember,
  isSplit,
  openNewTab,
  openTab,
  selectEntry,
  type ShellWorkspace,
} from '@/state/shell-workspace'
import { SETTINGS_KEY } from '@/state/tab-descriptor'

/**
 * Settings as a tab: it comes forward with the sidebar open to carry its nav,
 * and its Back goes to the tab used most recently before it, Settings staying
 * open. That is the workspace's own recency, the tab switcher's order, so
 * Back works however Settings was opened.
 */
export function useSettingsTab({
  update,
  showSidebar,
}: {
  update: (change: (w: ShellWorkspace) => ShellWorkspace) => void
  /** Open the nav's sidebar if it is folded (desktop only). */
  showSidebar: () => void
}) {
  /** Settings comes forward as a tab, its nav in place of the files. A
   *  folded sidebar opens for it, since the nav is how its pages are reached. */
  function openSettings() {
    update((w) => openTab(w, SETTINGS_KEY))
    showSidebar()
  }

  /** Settings' Back: to the most recently used other tab (a split comes
   *  forward as it is now), else Settings' neighbour in its own split, else a
   *  New tab, so Back always lands somewhere. */
  function leaveSettings() {
    update((w) => {
      const here = entryOf(w, SETTINGS_KEY)
      const hereId = here === null ? null : entryId(here)
      const back = entriesByRecency(w).find((id) => id !== hereId)
      if (back !== undefined) return selectEntry(w, back)
      const sibling = isSplit(here) ? here.views.find((v) => v !== SETTINGS_KEY) : undefined
      if (isSplit(here) && sibling !== undefined) return focusMember(w, here.id, sibling)
      return openNewTab(w)
    })
  }

  return { openSettings, leaveSettings }
}
