/**
 * Where the tree opens its "new file" / "new folder" input.
 */
export interface TreeRow {
  id: string
  level: number
}

export interface PendingSlot {
  /** Render the input directly after this row, or at the top when null. */
  afterId: string | null
  level: number
}

export function pendingSlot(rows: TreeRow[], parent: string): PendingSlot {
  const at = rows.find((r) => r.id === parent)
  if (at === undefined) return { afterId: null, level: 0 }
  return { afterId: at.id, level: at.level + 1 }
}
