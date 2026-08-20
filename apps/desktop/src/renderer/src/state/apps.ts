/**
 * Which vault apps exist, and closing one that stopped existing.
 *
 * An app is a directory under `.holi/apps/` holding **both** an entry document
 * (`index.html`) and a manifest (`app.yaml`), at its own root. The manifest is
 * the registration marker: an agent writes an app file by file, so without one
 * the app appears in the sidebar the moment its first byte lands and opens to a
 * half-written page. The manifest is written last, and it means *finished* —
 * which is why it is not sufficient on its own, since an app with no entry
 * document is a promise with nothing behind it.
 *
 * The rule "manifest + entry document" is also applied by
 * `main/apps/migrate-manifests.ts` and by the `vault-app-check` hook, neither of
 * which can read an atom. It is stated here and re-implemented there
 * deliberately, rather than shared through a layer the three have in common —
 * there is no such layer, and inventing one for three call sites is the
 * `manifest.json` mistake D74 refused.
 *
 * The list is derived from the snapshot rather than fetched, so an app the
 * agent finishes appears as soon as the watcher rescans, with no restart and no
 * refresh.
 */
import { atom } from 'jotai'
import { APPS_DIR, APP_MANIFEST_FILE, appIdFromPath } from '@holi/shared'
import { closeTab, workspaceAtom } from './panes'
import { snapshotAtom } from './vaults'

const ENTRY_FILE = 'index.html'

/** ids that have each of the two files at their own app root. A nested
 *  `sub/index.html` is a page inside an app and `sub/app.yaml` is a stray file;
 *  neither is a second app. */
const rootFilesAtom = atom((get) => {
  const entries = new Set<string>()
  const manifests = new Set<string>()
  for (const file of get(snapshotAtom).files) {
    const id = appIdFromPath(file.path)
    if (id === null) continue
    if (file.path === `${APPS_DIR}/${id}/${ENTRY_FILE}`) entries.add(id)
    else if (file.path === `${APPS_DIR}/${id}/${APP_MANIFEST_FILE}`) manifests.add(id)
  }
  return { entries, manifests }
})

/** Every registered app in the open vault, by id, sorted. */
export const appIdsAtom = atom((get) => {
  const { entries, manifests } = get(rootFilesAtom)
  return [...entries].filter((id) => manifests.has(id)).sort()
})

/**
 * Directories that have an entry document but no manifest — an app someone
 * started and has not finished.
 *
 * They are kept apart rather than dropped so the absence is *legible*. Silent
 * non-appearance is the failure mode slice 1 proved worst: the agent writes an
 * app, nothing shows up, and there is nowhere to look.
 */
export const unregisteredAppIdsAtom = atom((get) => {
  const { entries, manifests } = get(rootFilesAtom)
  return [...entries].filter((id) => !manifests.has(id)).sort()
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
