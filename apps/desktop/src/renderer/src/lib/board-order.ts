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

/** One card's new rank. */
export type Rank = { path: string; order: number }

/**
 * The writes that put a card dropped into `cell` at `index`, counted among the
 * cell's cards **without** the dragged one: where the gap opened. The dragged
 * card's rank is last. **Null** when the drop would not move it.
 *
 * `cell` is the target cell, which holds the dragged card only on a same-cell
 * drop. That is also the only drop that can be a no-op, and the test is
 * positional, not numeric: a no-op can compute a different rank (`1.5`
 * between `1` and `3` gives `2`), but re-inserting at its old index
 * reproduces the old sequence, and no other index does.
 *
 * **Unranked cards above the gap are ranked too, in the order shown.** They
 * sort last and by title, so no rank of the dragged card alone can put it
 * below one of them: it would jump up to the last ranked card. Ranking them
 * pins the order the person was looking at, so this happens once per cell;
 * after that a drop is one write.
 */
export function rankAt(cell: Task[], draggedPath: string, index: number): Rank[] | null {
  const sorted = sortCell(cell)
  const without = sorted.filter((t) => t.path !== draggedPath)
  const at = Math.max(0, Math.min(index, without.length))
  if (sorted.findIndex((t) => t.path === draggedPath) === at) return null
  const writes: Rank[] = []
  let previous: number | null = null
  for (const t of without.slice(0, at)) {
    if (t.order !== undefined) previous = t.order
    else {
      previous = rankBetween(previous, null)
      writes.push({ path: t.path, order: previous })
    }
  }
  writes.push({ path: draggedPath, order: rankBetween(previous, without[at]?.order ?? null) })
  return writes
}
