/**
 * The NavTree's rules, apart from its DOM: which rows are showing, what a
 * range selection spans, where typeahead lands, and where a drop may go.
 */
import { ROOT_ID, type TreeItemData } from './tree-data'
import { parentOf } from './tree-paths'

export interface NavRow {
  id: string
  isFolder: boolean
}

/** The rows on screen, top to bottom: a folder's contents only while it is open. */
export function visibleRows(data: Record<string, TreeItemData>, open: Set<string>): NavRow[] {
  const rows: NavRow[] = []
  const walk = (parent: string) => {
    for (const id of data[parent]?.children ?? []) {
      const node = data[id]
      if (!node) continue
      rows.push({ id, isFolder: node.isFolder })
      if (node.isFolder && open.has(id)) walk(id)
    }
  }
  walk(ROOT_ID)
  return rows
}

/** The rows from `anchor` to `target` inclusive, in screen order. */
export function rangeBetween(rows: NavRow[], anchor: string, target: string): string[] {
  const a = rows.findIndex((r) => r.id === anchor)
  const b = rows.findIndex((r) => r.id === target)
  if (b < 0) return []
  if (a < 0) return [target]
  return rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.id)
}

/**
 * Where a typed prefix lands: the first row, from the focused one onwards and
 * wrapping, whose name starts with it. The focused row counts, so typing more
 * of its own name keeps it.
 */
export function typeahead(
  rows: NavRow[],
  from: string,
  query: string,
  label: (id: string) => string,
): string | undefined {
  const q = query.toLowerCase()
  const start = Math.max(
    0,
    rows.findIndex((r) => r.id === from),
  )
  const order = [...rows.slice(start), ...rows.slice(0, start)]
  return order.find((r) => label(r.id).toLowerCase().startsWith(q))?.id
}

/** A move that changes something: not where it already is, not into itself. */
export function canMoveInto(sources: string[], dest: string): boolean {
  return sources.every((s) => parentOf(s) !== dest && dest !== s && !dest.startsWith(`${s}/`))
}

/** The folder a drop lands in: the folder under the pointer, a file's folder, or the root. */
export function dropFolder(id: string | null, isFolder: boolean): string {
  if (id === null) return ''
  return isFolder ? id : parentOf(id)
}
