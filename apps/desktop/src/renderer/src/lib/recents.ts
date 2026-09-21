/**
 * A most-recent-first list of things opened or run (D102).
 *
 * Pure, so the rule is one place and node-tested: an entry moves to the
 * front rather than appearing twice, the list is capped, and a dead entry is
 * pruned when the caller says what is still live. What is "live" is the
 * caller's to say — the snapshot for paths, main's list for sessions —
 * because this module knows nothing but keys.
 */
export type RecentKind = 'path' | 'app' | 'session' | 'surface' | 'command'

export interface RecentEntry {
  kind: RecentKind
  /** A vault-relative path, an app id, a session id, a `SingletonTab`, or a
   *  command id, by `kind`. */
  key: string
}

export const RECENTS_CAP = 50

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
