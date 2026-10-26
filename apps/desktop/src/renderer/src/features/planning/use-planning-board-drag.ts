/**
 * The Board's drag: the arrangement shown while a card is held, and the
 * writes a drop makes (its status, and its rank among the cards it landed
 * between). The view keeps nothing of a task; the preview lasts only until
 * the writes land.
 */
import { useRef, useState } from 'react'
import { columnFor, type StatusDef, type Task } from '@holi/shared'
import { useSetAtom } from 'jotai'

import type { KanbanCommitMeta } from '@/components/reui/kanban'
import { rankAt } from '@/lib/board-order'
import { patchTaskAtom, rankTasksAtom } from '@/state/tasks'

import { reportError } from './report-error'

export type Columns = Record<string, Task[]>

export function usePlanningBoardDrag({
  taskMap,
  statuses,
  sort,
  resting,
}: {
  taskMap: ReadonlyMap<string, Task>
  statuses: readonly StatusDef[]
  sort: string
  /** The columns as the vault arranges them. */
  resting: Columns
}) {
  const patch = useSetAtom(patchTaskAtom)
  const rankAll = useSetAtom(rankTasksAtom)
  /** The board's arrangement while a drag is on, and after a drop until its
   *  writes land; null at rest, when the board is the vault's. */
  const [preview, setPreview] = useState<Columns | null>(null)
  const committing = useRef(false)

  /** A drop's writes: the status when the column changed, and the card's
   *  rank among the cards it was dropped between. A sort other than Manual
   *  orders the column itself, so a drop there changes only the status. */
  const commit = async (path: string, column: string, index: number) => {
    const task = taskMap.get(path)
    if (!task) return
    const from = columnFor(statuses, task.status).id
    const newStatus = column !== from ? column : undefined
    const ranks = sort === 'manual' ? rankAt(resting[column] ?? [], path, index) : null
    const rank = ranks?.at(-1)?.order
    if (newStatus === undefined && rank === undefined) return
    if (ranks && ranks.length > 1) await rankAll(ranks.slice(0, -1))
    await patch(path, {
      ...(newStatus !== undefined ? { status: newStatus } : {}),
      ...(rank !== undefined ? { order: rank } : {}),
    })
  }

  const onCommit = (final: Columns, meta: KanbanCommitMeta<Task>) => {
    if (meta.kind !== 'item') return
    committing.current = true
    const column = meta.overContainer
    const path = String(meta.event.active.id)
    const index = (final[column] ?? [])
      .slice(0, meta.overIndex)
      .filter((t) => t.path !== path).length
    void commit(path, column, index)
      .catch(reportError('The task could not be moved'))
      .finally(() => {
        committing.current = false
        setPreview(null)
      })
  }

  return {
    value: preview ?? resting,
    onValueChange: setPreview,
    onValueCommit: onCommit,
    onDragEnd: () => {
      // A drop that moved nothing commits nothing: back to the vault's
      // arrangement. One that did waits for its writes.
      setTimeout(() => {
        if (!committing.current) setPreview(null)
      })
    },
    onDragCancel: () => setPreview(null),
  }
}
