/**
 * Closing panes and tabs as atoms: a key, the menu and the palette all wait
 * for pending text to reach disk before destroying its editor.
 */
import { atom } from 'jotai'
import { saveBeforeClosing } from '@/lib/buffer-registry'
import { closeTab, focusPane, workspaceAtom } from './panes'

/** Close one tab only after saving; failures keep the editor available for retry.
 * @public exported for its test
 */
export const closeTabAtom = atom(
  null,
  async (get, set, paneIndex: number, tabIndex: number): Promise<void> => {
    const before = get(workspaceAtom)
    await saveBeforeClosing(() => {
      // Never close a different tab that inherited these indexes while saving.
      if (get(workspaceAtom) !== before) return
      set(workspaceAtom, closeTab(focusPane(before, paneIndex), tabIndex))
    })
  },
)

/** ⌘W closes the focused pane's active tab, including an empty split pane. */
export const closeActiveTabAtom = atom(null, async (get, set): Promise<void> => {
  const w = get(workspaceAtom)
  const focused = w.panes[w.active]
  if (focused === undefined) return
  await set(closeTabAtom, w.active, focused.active)
})
