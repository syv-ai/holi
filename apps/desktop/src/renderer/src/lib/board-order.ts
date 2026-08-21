/**
 * The order of cards inside one board cell (`prd/tasks.md` §Board UX).
 *
 * A cell is `(column, lane)`, and a card's place in it is its `order` — a
 * sparse rank in the task's own frontmatter. Sorting lives here rather than in
 * the view because it is a rule with two halves worth stating: **absent sorts
 * last**, and **ties break by title**.
 */
import { rankBetween, type Task } from '@holi/shared'

/**
 * Cards in the order the column shows them.
 *
 * Unranked last: that is where a task the agent just wrote belongs — at the
 * bottom, not above everything a person deliberately placed. Reading absent as
 * rank zero would do exactly that.
 *
 * Then title, because a comparator that returns 0 leaves the order to the input
 * and the input is a filesystem scan. Without the tiebreak the board reshuffles
 * on an unrelated rescan, which reads as the board losing your work.
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
 * The dragged card is taken out of the cell before the neighbours are read —
 * without that, dropping a card just below the one above it would compute a
 * rank between itself and its neighbour and land it back where it started.
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

  // A drag that ends where it started is the commonest miss, and every rank
  // written is a file rewritten. The test is **positional**, not numeric: the
  // rank a no-op computes is not always the one the card already holds (drop
  // `1.5` back between `1` and `3` and the midpoint is `2`), but the sequence
  // it produces is the one already on screen.
  // `without` is `sorted` with the dragged card removed, so re-inserting it at
  // its own old index reproduces the old sequence exactly — and any other index
  // does not. Widening this by one in either direction swallows a real move:
  // dropping the first card below the second reads as "already there".
  const wasAt = sorted.findIndex((t) => t.path === draggedPath)
  if (wasAt === at) return null

  const previous = without[at - 1] ?? null
  const next = without[at] ?? null
  return rankBetween(previous?.order ?? null, next?.order ?? null)
}
