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
import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { touch, type RecentEntry } from '../lib/recents'
import type { Tab } from './panes'
import { activeRemoteAtom } from './vaults'

export const recentsByVaultAtom = atomWithStorage<Record<string, RecentEntry[]>>('holi:recents', {})

const NONE: RecentEntry[] = []

/** The active vault's list, most recent first. Empty with no vault. */
export const recentsAtom = atom<RecentEntry[]>((get) => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return NONE
  return get(recentsByVaultAtom)[remote] ?? NONE
})

export const touchRecentAtom = atom(null, (get, set, entry: RecentEntry): void => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return
  set(recentsByVaultAtom, (all) => ({ ...all, [remote]: touch(all[remote] ?? NONE, entry) }))
})

/** The recent a tab counts as, or null for a kind that is not remembered. */
export function recentOfTab(tab: Tab): RecentEntry | null {
  switch (tab.kind) {
    case 'note':
      return { kind: 'path', key: tab.path }
    case 'app':
      return { kind: 'app', key: tab.appId }
    case 'session':
      return { kind: 'session', key: tab.id }
    default:
      return { kind: 'surface', key: tab.kind }
  }
}
