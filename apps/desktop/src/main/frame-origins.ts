/** Owns the live origins accepted by the app-window navigation guard. */
export function createFrameOrigins(): {
  origins: ReadonlySet<string>
  acquire(origin: string): () => void
} {
  const leases = new Map<string, Set<symbol>>()
  const snapshot = (): Set<string> => new Set(leases.keys())
  const origins: ReadonlySet<string> = {
    get size() {
      return leases.size
    },
    has: (origin) => leases.has(origin),
    entries: () => snapshot().entries(),
    keys: () => snapshot().keys(),
    values: () => snapshot().values(),
    forEach: (callback, thisArg) => {
      for (const origin of snapshot()) callback.call(thisArg, origin, origin, origins)
    },
    [Symbol.iterator]: () => snapshot().values(),
  }
  return {
    origins,
    acquire(origin) {
      const token = Symbol(origin)
      const owners = leases.get(origin) ?? new Set<symbol>()
      owners.add(token)
      leases.set(origin, owners)
      let live = true
      return () => {
        if (!live) return
        live = false
        owners.delete(token)
        if (owners.size === 0 && leases.get(origin) === owners) leases.delete(origin)
      }
    },
  }
}
