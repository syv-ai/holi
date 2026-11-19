import type { VaultCliTarget } from '../claude/cli'

/** Owns stops started after admission closes and retains failures for teardown. */
export function createLateSessionCleanup(
  stop: (target: VaultCliTarget, id: string) => Promise<void>,
) {
  const pending = new Set<Promise<unknown>>()
  const failures: unknown[] = []

  function track<T>(work: Promise<T>): Promise<T> {
    const tracked = work
      .catch((error: unknown) => {
        failures.push(error)
        throw error
      })
      .finally(() => pending.delete(tracked))
    pending.add(tracked)
    return tracked
  }

  return {
    get size() {
      return pending.size
    },
    get pending() {
      return [...pending]
    },
    recordFailure(error: unknown): void {
      failures.push(error)
    },
    stop(target: VaultCliTarget, id: string): Promise<void> {
      return track(stop(target, id))
    },
    takeFailures(): unknown[] {
      return failures.splice(0)
    },
  }
}
