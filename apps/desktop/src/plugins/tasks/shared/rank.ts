/**
 * Sparse ranks: where a dragged card lands between its neighbours
 * (docs/features/tasks.md).
 *
 * **The property worth protecting is that a drop writes one file.** The card
 * takes a rank strictly between its neighbours, and nothing else moves. Dense
 * integers would be N file writes for one drag, and N conflicts on a shared vault.
 *
 * The cost: repeatedly dropping into the *same* gap halves it each time, so a
 * rank eventually runs out of precision. `STEP` at the open ends keeps drops at
 * the top or bottom from narrowing anything, and `needsRenumber` names the rest.
 */

/** The distance a rank moves past an open end. Whole numbers, so a column that
 *  has only ever been appended to reads as 1, 2, 3 in the files. */
const STEP = 1

export function rankBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return STEP
  if (before === null) return after! - STEP
  if (after === null) return before + STEP
  return (before + after) / 2
}

/**
 * How close two ranks may get before the midpoint between them stops being
 * reliably distinct from both. Doubles carry ~15–16 significant digits and
 * ranks start near 1, so this is a renumber *trigger* with room to spare, not
 * the precision floor itself.
 */
const MIN_GAP = 1e-6

/** Whether a column's ranks, in order, have been subdivided far enough that
 *  it should be rewritten as whole numbers. Only ever true of a gap that has
 *  been dropped into ~20 times without anything else changing. */
export function needsRenumber(ranks: number[]): boolean {
  return ranks.some((rank, i) => i > 0 && rank - ranks[i - 1]! < MIN_GAP)
}
