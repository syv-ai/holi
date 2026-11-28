/**
 * Map with bounded concurrency while preserving input order.
 *
 * A failed worker closes admission immediately, but work already admitted still
 * owns its slot until it settles. Only then does the original failure leave the
 * pool, so callers can safely treat settlement as physical teardown.
 */
export async function mapPooled<T, R>(
  values: readonly T[],
  size: number,
  work: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length)
  let next = 0
  let failed = false
  let failure: unknown

  await Promise.all(
    Array.from({ length: Math.min(size, values.length) }, async () => {
      for (;;) {
        if (failed) return
        const index = next
        if (index >= values.length) return
        next += 1
        try {
          result[index] = await work(values[index]!)
        } catch (error) {
          if (!failed) {
            failed = true
            failure = error
          }
          return
        }
      }
    }),
  )

  if (failed) throw failure
  return result
}
