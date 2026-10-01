/**
 * Recents per vault, kept on this machine.
 *
 * `localStorage` rather than `.holi/settings/app.local.yaml`: that file is a
 * settings document the user or the agent authors, its validator refuses keys
 * Holi has not declared, and every write regenerates the whole file. A list
 * that changes on every tab switch is UI state.
 *
 * Recording happens in two places only: Shell watches the active tab, and
 * `runCommandAtom` records each command it runs.
 */
import { atom, type Getter } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { entryOfTab, prune, touch, type RecentEntry } from '../lib/recents'
import type { Tab } from './panes'
import { surfacesAtom } from './plugins'
import { activeRemoteAtom, snapshotAtom } from './vaults'

export const recentsByVaultAtom = atomWithStorage<Record<string, RecentEntry[]>>('holi:recents', {})

const NONE: RecentEntry[] = []

/**
 * Whether an entry still names something. A tab of a surface that lists its
 * tabs (`Surface.tabs`, an agent's terminals) is live only while it is
 * listed: terminals do not survive a restart. Paths, and the
 * instances of a surface that lists them (a vault app), are judged only once
 * the vault has been scanned: an empty snapshot is a vault that has not
 * loaded yet, not a vault with nothing in it, and pruning against it would
 * wipe every path.
 */
function isLive(get: Getter): (entry: RecentEntry) => boolean {
  const snapshot = get(snapshotAtom)
  const scanned = snapshot.docs.length + snapshot.files.length > 0
  const paths = new Set([...snapshot.docs, ...snapshot.files].map((d) => d.path))
  const surfaces = get(surfacesAtom)
  const instances = (surface: string): ReadonlySet<string> | null => {
    const of = surfaces.get(surface)?.instances
    return of === undefined ? null : new Set(get(of))
  }
  const tabs = (surface: string): ReadonlySet<string> | null => {
    const of = surfaces.get(surface)?.tabs
    return of === undefined ? null : new Set(get(of).map((t) => t.id))
  }
  return (entry) => {
    switch (entry.kind) {
      case 'path':
        return !scanned || paths.has(entry.key)
      case 'surface': {
        if (entry.id === undefined) return true
        const listed = tabs(entry.key)
        if (listed !== null) return listed.has(entry.id)
        return !scanned || (instances(entry.key)?.has(entry.id) ?? true)
      }
      default:
        return true
    }
  }
}

/** The active vault's list, most recent first. Empty with no vault. */
export const recentsAtom = atom<RecentEntry[]>((get) => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return NONE
  return get(recentsByVaultAtom)[remote] ?? NONE
})

export const touchRecentAtom = atom(null, (get, set, entry: RecentEntry): void => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return
  // Pruned on every write, so the cap counts what still exists rather than
  // every session that ever ran and every path since renamed.
  const live = isLive(get)
  set(recentsByVaultAtom, (all) => ({
    ...all,
    [remote]: touch(prune(all[remote] ?? NONE, live), entry),
  }))
})

/** Kept for its callers; the rule is `entryOfTab` in `lib/recents.ts`. */
export function recentOfTab(tab: Tab): RecentEntry {
  return entryOfTab(tab)
}

/**
 * A surface's ids most recently opened first, then the rest in the order
 * given: what a surface's `instances` is, so the app you just used is the one
 * you want again.
 */
export function byRecency(
  recents: readonly RecentEntry[],
  surface: string,
  ids: readonly string[],
) {
  const order = new Map<string, number>()
  recents.forEach((r, i) => {
    if (r.kind === 'surface' && r.key === surface && r.id !== undefined && !order.has(r.id)) {
      order.set(r.id, i)
    }
  })
  const rank = (id: string) => order.get(id) ?? Infinity
  // The sort is stable, so the unused keep the order given.
  return [...ids].sort((a, b) => rank(a) - rank(b))
}
