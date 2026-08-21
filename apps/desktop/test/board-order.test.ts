/**
 * The order of cards inside one board cell (`prd/tasks.md` §Board UX).
 */
import { describe, expect, it } from 'vitest'
import type { Task } from '@holi/shared'
import { reorderRank, sortCell } from '../src/renderer/src/lib/board-order'

const task = (title: string, order?: number): Task =>
  ({ path: `task.${title}.md`, title, status: 'todo', tags: [], description: '', order }) as Task

describe('sortCell', () => {
  it('puts a ranked card where its rank says', () => {
    const sorted = sortCell([task('b', 2), task('a', 1)])
    expect(sorted.map((t) => t.title)).toEqual(['a', 'b'])
  })

  it('sorts an unranked card last, not first', () => {
    // Where a task the agent just wrote lands. Absent has to mean "the bottom"
    // rather than "rank zero", or every new task would arrive above everything
    // a human has deliberately placed.
    const sorted = sortCell([task('new'), task('placed', 2)])
    expect(sorted.map((t) => t.title)).toEqual(['placed', 'new'])
  })

  it('breaks a tie by title, so the board never shuffles on its own', () => {
    // Two unranked cards, or two that were somehow written the same rank. A
    // comparator that returned 0 would leave the order to the input, and the
    // input is a filesystem scan — the board would reshuffle on an unrelated
    // rescan.
    const sorted = sortCell([task('beta'), task('alpha')])
    expect(sorted.map((t) => t.title)).toEqual(['alpha', 'beta'])
  })
})

describe('reorderRank', () => {
  it('gives a card dropped above the top card a rank that beats it', () => {
    const cell = [task('a', 1), task('b', 2), task('c', 3)]
    const rank = reorderRank(cell, 'task.c.md', 'task.a.md', true)
    expect(rank).not.toBeNull()
    expect(rank!).toBeLessThan(1)
  })

  it('writes nothing when the card is dropped where it already is', () => {
    // A drag that ends where it started is the commonest miss, and every rank
    // written is a file rewritten and a commit. The check is positional rather
    // than numeric: the rank a no-op computes is not always the one the card
    // already has, but the sequence it produces is the same one.
    const cell = [task('a', 1), task('b', 1.5), task('c', 3)]
    expect(reorderRank(cell, 'task.b.md', 'task.a.md', false)).toBeNull()
    expect(reorderRank(cell, 'task.b.md', 'task.c.md', true)).toBeNull()
  })

  it('still moves a card dropped just below its own neighbour', () => {
    // The near miss of the no-op above: dropping the FIRST card below the
    // second is a real move, and an off-by-one in the "did it move" test reads
    // it as a no-op and silently does nothing.
    const cell = [task('a', 1), task('b', 2), task('c', 3)]
    const rank = reorderRank(cell, 'task.a.md', 'task.b.md', false)
    expect(rank).not.toBeNull()
    expect(rank!).toBeGreaterThan(2)
    expect(rank!).toBeLessThan(3)
  })

  it('ignores a card dropped on itself', () => {
    const cell = [task('a', 1), task('b', 2)]
    expect(reorderRank(cell, 'task.a.md', 'task.a.md', true)).toBeNull()
  })
})
