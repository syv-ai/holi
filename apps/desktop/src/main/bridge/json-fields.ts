type FieldPath = readonly string[]

type Selection = { terminal: boolean; children: Map<string, Selection> }

function selectionFor(paths: readonly FieldPath[]): Selection {
  const root: Selection = { terminal: false, children: new Map() }
  for (const path of paths) {
    let current = root
    for (const segment of path) {
      let child = current.children.get(segment)
      if (child === undefined) {
        child = { terminal: false, children: new Map() }
        current.children.set(segment, child)
      }
      current = child
    }
    current.terminal = true
  }
  return root
}

/**
 * Select own-property paths while retaining array shape and order. A terminal
 * path wins over any narrower selections, so overlapping selectors are
 * order-independent. Missing object properties are omitted; null/scalar values
 * reached before a path ends become null (including at the root).
 */
export function projectJsonFields(value: unknown, paths: readonly FieldPath[]): unknown {
  const root = selectionFor(paths)

  const project = (current: unknown, selection: Selection): unknown => {
    if (selection.terminal) return current
    if (Array.isArray(current)) return current.map((item) => project(item, selection))
    if (current === null || typeof current !== 'object') return null

    const output: Record<string, unknown> = {}
    for (const [key, child] of selection.children) {
      if (!Object.hasOwn(current, key)) continue
      const selected = project((current as Record<string, unknown>)[key], child)
      Object.defineProperty(output, key, {
        value: selected,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    return output
  }

  return project(value, root)
}
