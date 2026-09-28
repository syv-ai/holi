/**
 * The order of cards inside one board cell (`docs/features/tasks.md`). A cell is
 * `(column, lane)`; a card's place is its `order`, a sparse rank in its own
 * frontmatter.
 */
import { rankBetween, type Task } from '@holi/shared'

/**
 * Cards in the order the column shows them.
 *
 * Unranked last, so a task the agent just wrote does not jump above cards a
 * person placed. Then title: otherwise the order is the filesystem scan's, and
 * the board reshuffles on unrelated rescans.
 */
export function sortCell(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (a.order !== b.order) {
      if (a.order === undefined) return 1
      if (b.order === undefined) return -1
      return a.order - b.order
    }
    return a.title.localeCompare(b.title)
  })
}

/**
 * The rank for a card dropped into `cell` at `index`, counted among the cell's
 * cards **without** the dragged one: where the gap opened. **Null** when the
 * drop would not move it.
 *
 * `cell` is the target cell, which holds the dragged card only on a same-cell
 * drop. That is also the only drop that can be a no-op, and the test is
 * positional, not numeric: a no-op can compute a different rank (`1.5`
 * between `1` and `3` gives `2`), but re-inserting at its old index
 * reproduces the old sequence, and no other index does.
 */
export function rankAt(cell: Task[], draggedPath: string, index: number): number | null {
  const sorted = sortCell(cell)
  const without = sorted.filter((t) => t.path !== draggedPath)
  const at = Math.max(0, Math.min(index, without.length))
  if (sorted.findIndex((t) => t.path === draggedPath) === at) return null
  // Unranked cards sort last, so a gap among them sits just below the last
  // ranked card above it: rank from that one, or the drop would jump to the
  // top of the cell.
  const previous = without
    .slice(0, at)
    .filter((t) => t.order !== undefined)
    .at(-1)
  const next = without[at]
  return rankBetween(previous?.order ?? null, next?.order ?? null)
}
