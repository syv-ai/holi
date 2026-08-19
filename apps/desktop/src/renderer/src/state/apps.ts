/**
 * Which vault apps exist, and closing one that stopped existing.
 *
 * An app is a directory under `.holi/apps/` **with an entry document** — the
 * `index.html` requirement is what keeps an agent that created the directory
 * and then crashed from leaving a permanent broken row in the sidebar. The list
 * is derived from the snapshot rather than fetched, so an app the agent writes
 * appears as soon as the watcher rescans, with no restart and no refresh.
 */
import { atom } from 'jotai'
import { APPS_DIR, appIdFromPath } from '@holi/shared'
import { closeTab, workspaceAtom } from './panes'
import { snapshotAtom } from './vaults'

/** Every app in the open vault, by id, sorted. */
export const appIdsAtom = atom((get) => {
  const ids = new Set<string>()
  for (const file of get(snapshotAtom).files) {
    const id = appIdFromPath(file.path)
    // The entry document, and only at the app's own root: a nested
    // `sub/index.html` is a page inside an app, not a second app.
    if (id !== null && file.path === `${APPS_DIR}/${id}/index.html`) ids.add(id)
  }
  return [...ids].sort()
})

/** Close the tab showing `appId` in the active pane — what the tombstone's
 *  button does once the app it described is gone. */
export const closeAppAtom = atom(null, (_get, set, appId: string) => {
  set(workspaceAtom, (w) => {
    const pane = w.panes[w.active]
    if (pane === undefined) return w
    const index = pane.tabs.findIndex((t) => t.kind === 'app' && t.appId === appId)
    return index === -1 ? w : closeTab(w, index)
  })
})
