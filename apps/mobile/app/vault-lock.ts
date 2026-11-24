const locks = new Map<string, Promise<void>>()

/** Serializes operations for the same canonical root; unrelated roots proceed independently. */
export function withVaultLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(root) ?? Promise.resolve()
  const next = previous.then(work, work)
  const tail = next.then(
    () => {},
    () => {},
  )
  locks.set(root, tail)
  return next.finally(() => {
    if (locks.get(root) === tail) locks.delete(root)
  })
}
