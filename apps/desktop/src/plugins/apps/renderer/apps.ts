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
 * The same rule is re-implemented in `../main/ops.ts` and the
 * `vault-app-check` hook, deliberately: there is no shared layer, and inventing
 * one for three call sites is the mistake vault apps refused.
 *
 * Derived from the snapshot, so a finished app appears as soon as the watcher
 * rescans. An unfinished one (an entry document and no manifest) is a draft
 * of the app claim's folder document (`surface.tsx`).
 */
import { atom } from 'jotai'
import { selectAtom } from 'jotai/utils'
import { appBundleOf } from '@holi/shared'
import { APP_MANIFEST_FILE } from '../shared/manifest'
import { appName } from '../shared/bundle'
import { byRecency, recentsAtom, snapshotAtom } from '@/plugin-api'

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
 * The finished apps, most recently opened first, then the rest by name: the
 * `app` surface's instances. The same array until the order changes: the
 * recents move on every tab switch, and a new list restarts the nav menu's
 * layout pass.
 */
export const appInstancesAtom = selectAtom(
  atom((get) => byRecency(get(recentsAtom), 'app', get(appPathsAtom))),
  (paths) => paths,
  (a, b) => a.length === b.length && a.every((p, i) => p === b[i]),
)

/**
 * How many times each app has been reloaded since launch, by bundle path. Both
 * reloads count here: the pane header's reload button, and the agent's `holi
 * apps open` on an app that is already open, so an agent that just edited one
 * shows the new version with the command it already knows.
 */
export const appOpensAtom = atom<Record<string, number>>({})
