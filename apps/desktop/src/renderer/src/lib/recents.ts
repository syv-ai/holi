/**
 * A most-recent-first list of things opened or run (D102).
 *
 * An entry moves to the front rather than appearing twice, the list is capped,
 * and dead entries are pruned by a caller-supplied liveness test, since this
 * module knows only keys.
 */
import type { Tab } from '../state/panes'

export type RecentKind = 'path' | 'app' | 'session' | 'surface' | 'command'

export interface RecentEntry {
  kind: RecentKind
  /** A vault-relative path, an app bundle, a session id, a `SingletonTab`, or a
   *  command id, by `kind`. */
  key: string
}

export const RECENTS_CAP = 50

/** The recent a tab counts as. Every tab kind is remembered. */
export function entryOfTab(tab: Tab): RecentEntry {
  switch (tab.kind) {
    case 'note':
      return { kind: 'path', key: tab.path }
    case 'app':
      return { kind: 'app', key: tab.path }
    case 'session':
      return { kind: 'session', key: tab.id }
    default:
      return { kind: 'surface', key: tab.kind }
  }
}

export function sameEntry(a: RecentEntry, b: RecentEntry): boolean {
  return a.kind === b.kind && a.key === b.key
}

/** `entry` to the front, once; the tail past `cap` dropped. */
export function touch(
  list: readonly RecentEntry[],
  entry: RecentEntry,
  cap = RECENTS_CAP,
): RecentEntry[] {
  return [entry, ...list.filter((e) => !sameEntry(e, entry))].slice(0, cap)
}

/** Only the entries `isLive` accepts, order kept. */
export function prune(
  list: readonly RecentEntry[],
  isLive: (entry: RecentEntry) => boolean,
): RecentEntry[] {
  return list.filter(isLive)
}
