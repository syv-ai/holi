/**
 * A most-recent-first list of things opened or run.
 *
 * An entry moves to the front rather than appearing twice, the list is capped,
 * and dead entries are pruned by a caller-supplied liveness test, since this
 * module knows only keys.
 */
import { RECENTS_CAP, type RecentEntry } from '@holi/shared'
import type { Tab } from '../state/panes'

export { RECENTS_CAP, type RecentEntry, type RecentKind } from '@holi/shared'

/** The recent a tab counts as. Every tab kind is remembered. */
export function entryOfTab(tab: Tab): RecentEntry {
  switch (tab.kind) {
    case 'note':
      return { kind: 'path', key: tab.path }
    // An agent tab is a terminal, whatever session it shows now.
    case 'agent':
      return { kind: 'terminal', key: tab.id }
    case 'surface':
      return tab.id === undefined
        ? { kind: 'surface', key: tab.surface }
        : { kind: 'surface', key: tab.surface, id: tab.id }
  }
}

export function sameEntry(a: RecentEntry, b: RecentEntry): boolean {
  return a.kind === b.kind && a.key === b.key && a.id === b.id
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
