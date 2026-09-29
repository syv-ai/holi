/**
 * The board's drag (docs/features/tasks.md): native HTML5 drag and drop, with
 * a gap that springs open where the card would land.
 *
 * - **The source stays mounted and collapses.** Removing a drag source ends
 *   the drag, so the card folds to nothing in place and its neighbours close
 *   up behind it.
 * - **The gap is the aim.** Over a cell, the gap opens before the first card
 *   whose middle is below the pointer; the drop lands exactly there
 *   (`rankAt`), in any cell.
 * - **The gap outlives the drop until the write lands.** Writes re-read the
 *   vault (no optimistic data), so for a moment the file has not moved
 *   yet. The gap holds the space, and the card stays folded under both its
 *   old path and the one a lane move gives it, so the re-read cannot draw it
 *   full size beside its own gap. When the write resolves the gap closes as
 *   the card unfolds into it.
 *
 * The payload is the path as `text/plain`: the drop reads it from the drag
 * itself, and the tab strip reads it to refuse a card.
 */
import type { Task, TaskStatus } from '@holi/shared'
import { useState } from 'react'

type Slot = { cell: string; index: number }

export const cellKey = (status: TaskStatus, lane: string): string => `${status}:${lane}`

export function useBoardDrag(
  /** Moves `path` into `(lane, status)` at `index` of that cell's cards (the
   *  dragged card excluded), resolving once the vault has re-read. */
  commit: (path: string, lane: string, status: TaskStatus, index: number) => Promise<unknown>,
) {
  /** The card being dragged, and its height: the gap's height. */
  const [lifted, setLifted] = useState<{ path: string; height: number } | null>(null)
  const [slot, setSlot] = useState<Slot | null>(null)
  /** A drop whose write has not landed: its gap stays, its card stays folded. */
  const [holding, setHolding] = useState<(Slot & { paths: string[]; height: number }) | null>(null)

  const source = (task: Task) => ({
    draggable: true,
    onDragStart: (event: React.DragEvent<HTMLElement>) => {
      event.dataTransfer.setData('text/plain', task.path)
      event.dataTransfer.effectAllowed = 'move'
      const height = event.currentTarget.offsetHeight
      // A frame later: the browser snapshots the drag image first, and a
      // collapsed card would be an empty one.
      requestAnimationFrame(() => setLifted({ path: task.path, height }))
    },
    onDragEnd: () => {
      setLifted(null)
      setSlot(null)
    },
  })

  const target = (lane: string, status: TaskStatus) => {
    const key = cellKey(status, lane)
    return {
      'data-cell': key,
      onDragOver: (event: React.DragEvent<HTMLElement>) => {
        event.preventDefault()
        const cards = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-task]')].filter(
          (element) => element.dataset.task !== lifted?.path,
        )
        let index = cards.length
        for (const [i, card] of cards.entries()) {
          const box = card.getBoundingClientRect()
          if (event.clientY < box.top + box.height / 2) {
            index = i
            break
          }
        }
        if (slot?.cell !== key || slot.index !== index) setSlot({ cell: key, index })
      },
      onDragLeave: (event: React.DragEvent<HTMLElement>) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setSlot((current) => (current?.cell === key ? null : current))
      },
      onDrop: (event: React.DragEvent<HTMLElement>) => {
        event.preventDefault()
        const path = event.dataTransfer.getData('text/plain')
        const index = slot?.cell === key ? slot.index : 0
        const height = lifted?.height ?? 0
        setLifted(null)
        setSlot(null)
        if (!path) return
        // A lane move renames the file: the basename rides along (`tasks.move`).
        const basename = path.slice(path.lastIndexOf('/') + 1)
        const arriving = lane ? `${lane}/${basename}` : basename
        setHolding({ cell: key, index, paths: [path, arriving], height })
        void commit(path, lane, status, index)
          .catch(() => {})
          .finally(() => setHolding(null))
      },
    }
  }

  /** The open gap in a cell, if any: its index among the cell's other cards
   *  and its height. */
  const gap = (lane: string, status: TaskStatus): { index: number; height: number } | null => {
    const key = cellKey(status, lane)
    if (holding?.cell === key) return { index: holding.index, height: holding.height }
    if (slot?.cell === key && lifted) return { index: slot.index, height: lifted.height }
    return null
  }

  return {
    source,
    target,
    gap,
    /** Folded out of its cell: being dragged, or dropped and not yet written. */
    isFolded: (path: string) => lifted?.path === path || (holding?.paths.includes(path) ?? false),
    /** A drag is on: empty lane groups open, so every cell can take it. */
    active: lifted !== null || holding !== null,
  }
}

/** A cell's cards with the gap threaded in. The folded card keeps its place in
 *  the list (it is collapsing, not moving) and does not count toward the gap's
 *  index. */
export function withGap(
  cards: Task[],
  folded: (path: string) => boolean,
  gapIndex: number | null,
): ({ kind: 'card'; task: Task } | { kind: 'gap' })[] {
  const out: ({ kind: 'card'; task: Task } | { kind: 'gap' })[] = []
  let counted = 0
  for (const task of cards) {
    if (!folded(task.path)) {
      if (gapIndex === counted) out.push({ kind: 'gap' })
      counted += 1
    }
    out.push({ kind: 'card', task })
  }
  if (gapIndex !== null && gapIndex >= counted) out.push({ kind: 'gap' })
  return out
}
