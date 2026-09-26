/**
 * Which vault apps exist, and the actions on them (`docs/features/vault-apps.md`).
 *
 * An app is a bundle, a directory named `<name>.app` anywhere in the vault
 * (D107), holding **both** an entry document (`index.html`) and a manifest
 * (`app.yaml`) at its own root. The manifest is the "finished" marker, written
 * last: without it an app would appear the moment its first byte lands and open
 * to a half-written page. It is not sufficient on its own, since an app with no
 * entry document has nothing to open.
 *
 * The same rule is re-implemented in `main/apps/app-ops.ts` and the
 * `vault-app-check` hook, deliberately: there is no shared layer, and inventing
 * one for three call sites is the mistake D74 refused.
 *
 * Derived from the snapshot, so a finished app appears as soon as the watcher
 * rescans.
 */
import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { APP_MANIFEST_FILE, APP_SUFFIX, appBundleOf, appName, isAppBundlePath } from '@holi/shared'
import { trpc } from '../lib/trpc'
import { closeTab, workspaceAtom } from './panes'
import {
  activeRemoteAtom,
  deleteManyAtom,
  loadSnapshotAtom,
  moveNotesAtom,
  snapshotAtom,
} from './vaults'

const ENTRY_FILE = 'index.html'

/** Bundles that have each of the two files at their own root. A nested
 *  `sub/index.html` is a page inside an app and `sub/app.yaml` is a stray file;
 *  neither is a second app. */
const rootFilesAtom = atom((get) => {
  const entries = new Set<string>()
  const manifests = new Set<string>()
  for (const file of get(snapshotAtom).files) {
    const bundle = appBundleOf(file.path)
    if (bundle === null) continue
    if (file.path === `${bundle}/${ENTRY_FILE}`) entries.add(bundle)
    else if (file.path === `${bundle}/${APP_MANIFEST_FILE}`) manifests.add(bundle)
  }
  return { entries, manifests }
})

/** By name, then by path, so two apps of one name keep a stable order. */
const byName = (a: string, b: string): number =>
  appName(a).localeCompare(appName(b)) || a.localeCompare(b)

/** Every finished app in the open vault, by bundle path. */
export const appPathsAtom = atom((get) => {
  const { entries, manifests } = get(rootFilesAtom)
  return [...entries].filter((p) => manifests.has(p)).sort(byName)
})

/**
 * Bundles that have an entry document but no manifest: an app someone started
 * and has not finished.
 *
 * Kept apart rather than dropped so the absence is *legible*: otherwise the agent
 * writes an app, nothing shows up, and there is nowhere to look.
 */
export const unregisteredAppPathsAtom = atom((get) => {
  const { entries, manifests } = get(rootFilesAtom)
  return [...entries].filter((p) => !manifests.has(p)).sort(byName)
})

/** Close the tab showing the app at `path` in the active pane: the tombstone's
 *  button. */
export const closeAppAtom = atom(null, (_get, set, path: string) => {
  set(workspaceAtom, (w) => {
    const pane = w.panes[w.active]
    if (pane === undefined) return w
    const index = pane.tabs.findIndex((t) => t.kind === 'app' && t.path === path)
    return index === -1 ? w : closeTab(w, index)
  })
})

/** Every file inside each bundle: what a delete removes. */
export const appFilesAtom = atom((get) => {
  const byBundle = new Map<string, string[]>()
  for (const file of get(snapshotAtom).files) {
    const bundle = appBundleOf(file.path)
    if (bundle === null) continue
    const list = byBundle.get(bundle)
    if (list) list.push(file.path)
    else byBundle.set(bundle, [file.path])
  }
  return byBundle
})

/**
 * Is there an apps section at all?
 *
 * Shell asks before it builds the sidebar's panel group, because an empty
 * collapsible panel still takes a slice of the column and draws a handle. With
 * no apps the panel and its handle must be absent, not merely empty.
 */
export const hasAppsAtom = atom(
  (get) => get(appPathsAtom).length > 0 || get(unregisteredAppPathsAtom).length > 0,
)

/**
 * Is the apps panel expanded? Persisted, and global rather than per vault: it is
 * a statement about how you like the sidebar, not about this vault's contents.
 *
 * The panel's collapsed state is driven FROM this atom, never the reverse: a
 * panel-level callback cannot tell a real drag from the reflow that mounting a
 * sibling causes, so only the group-level `isUserInteraction` drag writes back.
 */
export const appsSectionOpenAtom = atomWithStorage<boolean>('holi:appsSectionOpen', true)

/** A refusal is a value, not a throw: the caller is an inline rename field with
 *  somewhere to put the reason. */
export type AppActionResult = { ok: true } | { ok: false; error: string }

/**
 * Rename an app: the tree's folder move of its bundle to `<name>.app` beside
 * it, so links are rewritten and open tabs follow as for any other move.
 *
 * Why a name cannot be used comes back as a value, for the inline field; main
 * refuses an overwrite too, and is the authority, since a teammate's pull can
 * create the destination between the keypress and the move.
 */
export const renameAppAtom = atom(
  null,
  async (
    get,
    set,
    { bundle, name }: { bundle: string; name: string },
  ): Promise<AppActionResult> => {
    const slash = bundle.lastIndexOf('/')
    const dest = `${slash === -1 ? '' : bundle.slice(0, slash + 1)}${name}${APP_SUFFIX}`
    if (dest === bundle) return { ok: true }
    if (name.includes('/') || !isAppBundlePath(dest)) {
      return { ok: false, error: `${name} cannot name an app` }
    }
    const snapshot = get(snapshotAtom)
    const taken = [...snapshot.files.map((f) => f.path), ...snapshot.dirs].some(
      (p) => p === dest || p.startsWith(`${dest}/`),
    )
    if (taken) return { ok: false, error: `${name} already exists` }
    const moves = (get(appFilesAtom).get(bundle) ?? []).map((from) => ({
      from,
      to: `${dest}${from.slice(bundle.length)}`,
    }))
    try {
      await set(moveNotesAtom, { moves })
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
    return { ok: true }
  },
)

/**
 * Write the manifest that turns a half-finished directory into an app.
 *
 * The same op as `holi app init`, which never overwrites: running it on a
 * finished app is a success with nothing created.
 */
export const registerAppAtom = atom(
  null,
  async (get, set, path: string): Promise<AppActionResult> => {
    const remote = get(activeRemoteAtom)
    if (remote === null) return { ok: false, error: 'no vault is open' }
    const result = await trpc.apps.register.mutate({ remote, path })
    if (!result.ok) return result
    await set(loadSnapshotAtom)
    return { ok: true }
  },
)

/**
 * Delete an app: every file inside it, then its tab.
 *
 * The tab is closed rather than left to show `AppFrame`'s tombstone, which is
 * for an app that vanished *from under* you (a teammate's pull).
 *
 * The now-empty directory is left behind, as when deleting a folder in the
 * tree; with no entry document it appears in neither list.
 */
export const deleteAppAtom = atom(null, async (get, set, bundle: string) => {
  const paths = get(appFilesAtom).get(bundle) ?? []
  if (paths.length === 0) return
  await set(deleteManyAtom, { paths })
  set(closeAppAtom, bundle)
})
