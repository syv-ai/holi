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
import { atomWithStorage } from 'jotai/utils'
import { APPS_DIR, APP_MANIFEST_FILE, appIdFromPath } from '@holi/shared'
import { flushAllBuffers } from '../lib/buffer-registry'
import { trpc } from '../lib/trpc'
import { closeTab, retargetAppTab, retargetTabs, workspaceAtom } from './panes'
import {
  activeDocAtom,
  activeRemoteAtom,
  deleteManyAtom,
  loadSnapshotAtom,
  snapshotAtom,
} from './vaults'

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

/**
 * Every id that has a directory under `.holi/apps/`, whether or not anything
 * inside it makes it an app.
 *
 * This — not `appIdsAtom` — is the set a new id must not collide with. An id
 * whose directory holds only a stylesheet is not an app and is not offered
 * anywhere, but renaming onto it would still be a rename onto occupied ground.
 * Main refuses that too (it stats the directory, which is the authority); this
 * exists so the field can say so before the round-trip.
 */
export const appDirIdsAtom = atom((get) => {
  const snapshot = get(snapshotAtom)
  const ids = new Set<string>()
  for (const path of [...snapshot.files.map((f) => f.path), ...snapshot.dirs]) {
    const id = appIdFromPath(path)
    if (id !== null) ids.add(id)
  }
  return ids
})

/** Every file inside each app, by id — what a delete has to remove and what a
 *  rename has to retarget open tabs for. */
export const appFilesAtom = atom((get) => {
  const byId = new Map<string, string[]>()
  for (const file of get(snapshotAtom).files) {
    const id = appIdFromPath(file.path)
    if (id === null) continue
    const list = byId.get(id)
    if (list) list.push(file.path)
    else byId.set(id, [file.path])
  }
  return byId
})

/**
 * Is there an apps section at all?
 *
 * Shell asks before it builds the sidebar's panel group, because a collapsible
 * panel cannot be conditional on its own contents: an empty panel still takes a
 * slice of the column and still draws a handle above it. The section is hidden
 * when the vault has no apps — the rule the agenda and mail chips follow — so
 * the panel and its handle have to be absent too, not merely empty.
 */
export const hasAppsAtom = atom(
  (get) => get(appIdsAtom).length > 0 || get(unregisteredAppIdsAtom).length > 0,
)

/**
 * Is the apps panel expanded? Persisted, and global rather than per vault: it is
 * a statement about how you like the sidebar, not about this vault's contents.
 *
 * The panel's collapsed state is driven FROM this atom, never the reverse — the
 * same arrangement `AgentPanel` uses, and for the same reason: a panel-level
 * callback cannot tell a real drag from the reflow that mounting a sibling
 * causes, so only the group-level `isUserInteraction` drag writes back here.
 */
export const appsSectionOpenAtom = atomWithStorage<boolean>('holi:appsSectionOpen', true)

/** A refusal is a value, not a throw: the caller is an inline rename field with
 *  somewhere to put the reason. */
export type AppActionResult = { ok: true } | { ok: false; error: string }

/**
 * Rename an app, and take everything pointing at the old id with it.
 *
 * Main does the directory rename and the `[[link]]` rewrite; this is the
 * renderer's half — the commit-pair ordering `moveNotesAtom` established (flush
 * the live buffers, commit a clean restore point, mutate, retarget, reload,
 * commit), plus the one thing no path-keyed helper can do: move the **app** tab,
 * whose identity is an id rather than a path.
 *
 * The flush is not decoration. An app file open in the editor has an unsaved
 * buffer keyed by its old path; without the flush that buffer would later save
 * itself back to a path the rename has already emptied, recreating the old
 * directory with one stale file in it.
 */
export const renameAppAtom = atom(
  null,
  async (get, set, { from, to }: { from: string; to: string }): Promise<AppActionResult> => {
    const remote = get(activeRemoteAtom)
    if (remote === null) return { ok: false, error: 'no vault is open' }
    if (from === to) return { ok: true }

    const prefix = `${APPS_DIR}/${from}/`
    const moves = (get(appFilesAtom).get(from) ?? []).map((path) => ({
      from: path,
      to: `${APPS_DIR}/${to}/${path.slice(prefix.length)}`,
    }))

    await flushAllBuffers()
    await trpc.sync.commitNow.mutate()
    const result = await trpc.apps.rename.mutate({ remote, from, to })
    if (!result.ok) return result

    set(workspaceAtom, retargetAppTab(retargetTabs(get(workspaceAtom), moves), from, to))
    const active = get(activeDocAtom)
    const moved = active ? moves.find((m) => m.from === active.path) : undefined
    await set(loadSnapshotAtom)
    if (moved) set(activeDocAtom, get(snapshotAtom).docs.find((d) => d.path === moved.to) ?? null)
    await trpc.sync.commitNow.mutate()
    return { ok: true }
  },
)

/**
 * Write the manifest that turns a half-finished directory into an app.
 *
 * The same op as `holi app init`, which never overwrites — so this cannot
 * clobber a manifest a teammate is mid-way through writing, and running it on an
 * app that is already finished is a success with nothing created.
 */
export const registerAppAtom = atom(
  null,
  async (get, set, appId: string): Promise<AppActionResult> => {
    const remote = get(activeRemoteAtom)
    if (remote === null) return { ok: false, error: 'no vault is open' }
    const result = await trpc.apps.register.mutate({ remote, appId })
    if (!result.ok) return result
    await set(loadSnapshotAtom)
    return { ok: true }
  },
)

/**
 * Delete an app: every file inside it, then its tab.
 *
 * The tab is closed rather than left to discover the app is gone. `AppFrame`'s
 * tombstone exists for the case where the app vanished *from under* you — a
 * teammate's pull — and answering "it was deleted" to the person who just chose
 * to delete it is noise, not information.
 *
 * What is left behind is the now-empty directory: `deleteMany` removes files,
 * and nothing here prunes a directory. That matches what deleting a folder in
 * the tree does, and an empty directory is not an app — it has no entry
 * document, so it appears in neither list.
 */
export const deleteAppAtom = atom(null, async (get, set, appId: string) => {
  const paths = get(appFilesAtom).get(appId) ?? []
  if (paths.length === 0) return
  await set(deleteManyAtom, { paths })
  set(closeAppAtom, appId)
})
