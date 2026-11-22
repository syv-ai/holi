import type { OwnedProgramCleanupLease } from '../../../../main/plugin-api'

/** Join cleanup on the original launch, never on a pid or a listing row. Keep
 * the first failure for the activation even if another path asks to drain it. */
export function createLateSessionCleanup() {
  const pending = new Set<Promise<unknown>>()
  const failures = new Set<unknown>()
  const revocations = new Map<OwnedProgramCleanupLease, Promise<void>>()

  function track<T>(work: () => Promise<T>): Promise<T> {
    const tracked = Promise.resolve()
      .then(work)
      .finally(() => pending.delete(tracked))
    pending.add(tracked)
    return tracked
  }

  return {
    get pending() {
      return [...pending]
    },
    track,
    recordFailure(error: unknown): void {
      failures.add(error)
    },
    revoke(lease: OwnedProgramCleanupLease): Promise<void> {
      const existing = revocations.get(lease)
      if (existing) return existing
      const revoking = track(() => lease.revoke())
      revocations.set(lease, revoking)
      return revoking
    },
    failures: () => [...failures],
  }
}
