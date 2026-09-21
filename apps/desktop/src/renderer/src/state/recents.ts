/**
 * Recents per vault, kept on this machine (D102).
 *
 * `localStorage` rather than `.holi/settings/app.local.yaml`: that file is a
 * settings document the user or the agent authors, its validator refuses keys
 * Holi has not declared, and every write regenerates the whole file. A list
 * that changes on every tab switch is UI state, the same kind of thing as the
 * panel layouts and the show-hidden flag beside it in storage.
 *
 * Recording happens in two places and only two: Shell watches the active tab
 * (so the tree, the strip and the palette all count, whichever opened it) and
 * `runCommandAtom` records each command it runs.
 */
import { atom, type Getter } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { entryOfTab, prune, touch, type RecentEntry } from '../lib/recents'
import { agentSessionsAtom } from './agent'
import { appIdsAtom } from './apps'
import type { Tab } from './panes'
import { activeRemoteAtom, snapshotAtom } from './vaults'

export const recentsByVaultAtom = atomWithStorage<Record<string, RecentEntry[]>>('holi:recents', {})

const NONE: RecentEntry[] = []

/**
 * Whether an entry still names something. Sessions do not survive a restart,
 * so a session recent is live only while main lists it. Paths and apps are
 * judged only once the vault has been scanned: an empty snapshot is a vault
 * that has not loaded yet, not a vault with nothing in it, and pruning
 * against it would wipe every path.
 */
function isLive(get: Getter): (entry: RecentEntry) => boolean {
  const snapshot = get(snapshotAtom)
  const scanned = snapshot.docs.length + snapshot.files.length > 0
  const paths = new Set([...snapshot.docs, ...snapshot.files].map((d) => d.path))
  const apps = new Set(get(appIdsAtom))
  const sessions = new Set(
    get(agentSessionsAtom)
      .filter((s) => !s.exited)
      .map((s) => s.id),
  )
  return (entry) => {
    switch (entry.kind) {
      case 'path':
        return !scanned || paths.has(entry.key)
      case 'app':
        return !scanned || apps.has(entry.key)
      case 'session':
        return sessions.has(entry.key)
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
