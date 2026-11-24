/** Removable cancellation registrations for operations owned by one frame adapter. */
export function createFrameContextCancellation() {
  const pending = new Set<(reason: Error) => void>()
  let cancelled: Error | undefined

  function run<T>(operation: PromiseLike<T>): Promise<T> {
    if (cancelled) {
      // Assimilate even post-cancel operations so any native rejection is observed.
      void Promise.resolve(operation).catch(() => {})
      return Promise.reject(cancelled)
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false
      const finish = (complete: () => void) => {
        if (settled) return
        settled = true
        pending.delete(cancel)
        complete()
      }
      const cancel = (reason: Error) => finish(() => reject(reason))
      pending.add(cancel)
      Promise.resolve(operation).then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      )
    })
  }

  function cancel(reason: Error) {
    if (cancelled) return
    cancelled = reason
    for (const reject of [...pending]) reject(reason)
  }

  return Object.freeze({
    run,
    cancel,
    get pendingCount() {
      return pending.size
    },
  })
}
