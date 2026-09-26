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
 * The rank a dragged card takes when it is dropped on `targetPath`, or **null**
 * when the drop would not move it.
 *
 * The dragged card is removed before reading neighbours, or it would rank
 * against itself.
 */
export function reorderRank(
  cell: Task[],
  draggedPath: string,
  targetPath: string,
  before: boolean,
): number | null {
  const sorted = sortCell(cell)
  const without = sorted.filter((t) => t.path !== draggedPath)
  const target = without.findIndex((t) => t.path === targetPath)
  if (target === -1) return null

  const at = before ? target : target + 1

  // A no-op drop must write no file. The test is positional, not numeric: a
  // no-op can compute a different rank (`1.5` between `1` and `3` gives `2`).
  // Re-inserting at its old index reproduces the old sequence, and no other
  // index does; widening by one would swallow a real move.
  const wasAt = sorted.findIndex((t) => t.path === draggedPath)
  if (wasAt === at) return null

  const previous = without[at - 1] ?? null
  const next = without[at] ?? null
  return rankBetween(previous?.order ?? null, next?.order ?? null)
}
