/**
 * Which vault apps exist, and the actions on them (`docs/features/vault-apps.md`).
 *
 * An app is a bundle, a directory named `<name>.app` anywhere in the vault,
 * holding **both** an entry document (`index.html`) and a manifest
 * (`app.yaml`) at its own root. The manifest is the "finished" marker, written
 * last: without it an app would appear the moment its first byte lands and open
 * to a half-written page. It is not sufficient on its own, since an app with no
 * entry document has nothing to open.
 *
 * The same rule is re-implemented in `main/apps/app-ops.ts` and the
 * `vault-app-check` hook, deliberately: there is no shared layer, and inventing
 * one for three call sites is the mistake vault apps refused.
 *
 * Derived from the snapshot, so a finished app appears as soon as the watcher
 * rescans.
 */
import { atom } from 'jotai'
import { APP_MANIFEST_FILE, appBundleOf, appName } from '@holi/shared'
import { trpc } from '../lib/trpc'
import { closeTab, workspaceAtom } from './panes'
import { activeRemoteAtom, loadSnapshotAtom, snapshotAtom } from './vaults'

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

/** A refusal is a value, not a throw: the caller has somewhere to put the
 *  reason. */
export type AppActionResult = { ok: true } | { ok: false; error: string }

/**
 * Write the manifest that turns a half-finished directory into an app.
 *
 * The same op as `holi apps init`, which never overwrites: running it on a
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
