import { useRef } from 'react'

import {
  entryIds,
  entryOf,
  openTab,
  selectEntry,
  type ShellWorkspace,
} from '@/state/shell-workspace'
import { SETTINGS_KEY } from '@/state/tab-descriptor'

/**
 * Settings as a tab: it comes forward with the sidebar open to carry its nav,
 * and its Back returns to the tab it came from, Settings staying open.
 */
export function useSettingsTab({
  focusedKey,
  update,
  showSidebar,
}: {
  /** The view in front. */
  focusedKey: string | null
  update: (change: (w: ShellWorkspace) => ShellWorkspace) => void
  /** Open the nav's sidebar if it is folded (desktop only). */
  showSidebar: () => void
}) {
  /** The tab in front when Settings came forward, for its Back. */
  const beforeSettings = useRef<string | null>(null)

  /** Settings comes forward as a tab, its nav in place of the files. A
   *  folded sidebar opens for it, since the nav is how its pages are reached. */
  function openSettings() {
    if (focusedKey !== SETTINGS_KEY) beforeSettings.current = focusedKey
    update((w) => openTab(w, SETTINGS_KEY))
    showSidebar()
  }

  /** Settings' Back: to the tab it came from, Settings staying open. */
  function leaveSettings() {
    const back = beforeSettings.current
    update((w) => {
      // Split tabs: back to that tab wherever it is now, else any other.
      if (back !== null && entryOf(w, back) !== null) {
        return selectEntry(w, back)
      }
      const other = entryIds(w).find((id) => id !== SETTINGS_KEY)
      return other === undefined ? w : selectEntry(w, other)
    })
  }

  return { openSettings, leaveSettings }
}
