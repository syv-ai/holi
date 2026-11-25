/** Reconcile an authoritative cached prefix without discarding separately loaded pages. */
export function mergeMailRefresh<T extends { id: string }>(
  previous: { threads: T[]; nextPageToken: string | null } | null,
  refreshed: { threads: T[]; nextPageToken: string | null },
  previousCachedIds: ReadonlySet<string>,
): { threads: T[]; nextPageToken: string | null } {
  const refreshedIds = new Set(refreshed.threads.map((thread) => thread.id))
  return {
    threads: [
      ...refreshed.threads,
      ...(previous?.threads.filter(
        (thread) => !previousCachedIds.has(thread.id) && !refreshedIds.has(thread.id),
      ) ?? []),
    ],
    // History deltas have no continuation; they do not exhaust Gmail's later pages.
    nextPageToken: previous?.nextPageToken ?? refreshed.nextPageToken,
  }
}
