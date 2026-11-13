// ReUI block: @reui/kanban-board-4 (`npx shadcn@latest view @reui/kanban-board-4` shows the published source)
/**
 * The board: kanban-board-4's columns, one Frame per status, holding
 * kanban-board-6's cards. The block's column grip is left out, since the
 * columns' order is `.holi/statuses.yaml`'s and the board does not write it.
 */
import { type ComponentProps, useEffect, useRef } from 'react'
import type { StatusDef, Task } from '@holi/shared'

import { Badge } from '@/components/ui/badge'
import { Frame, FrameHeader, FrameTitle } from '@/components/ui/frame'
import {
  Kanban,
  KanbanBoard as KanbanBoardPrimitive,
  KanbanColumn,
  KanbanColumnContent,
  KanbanOverlay,
  type KanbanCommitMeta,
} from '@/components/ui/kanban'

import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import { captureBoardScroll, restoreBoardScroll, type BoardScrollPosition } from '../board-scroll'
import { InlineAdd, type InlineAddState } from '../inline-add'
import { StatusIcon } from '../task-bits'
import { TaskCard, type CardContext } from './task-card'

interface StatusColumnProps extends Omit<
  ComponentProps<typeof KanbanColumn>,
  'value' | 'children'
> {
  status: StatusDef
  tasks: Task[]
  context: CardContext
  onAddTask: (status: string, title: string) => Promise<void>
  inlineAddState: Record<string, InlineAddState>
  onInlineAddStateChange: (status: string, state: InlineAddState) => void
  focused: boolean
}

function StatusColumn({
  status,
  tasks,
  context,
  onAddTask,
  inlineAddState,
  onInlineAddStateChange,
  focused,
  ...props
}: StatusColumnProps) {
  const isDone = status.category === 'completed'
  const addLabel = `Add task to ${status.name}`

  return (
    <KanbanColumn value={status.id} data-column={status.id} className="w-72 shrink-0" {...props}>
      <Frame spacing="sm" role="region" aria-label={`${status.name} tasks`}>
        <FrameHeader>
          <div className="flex min-h-10 items-center gap-2">
            <StatusIcon status={status} className="size-4" />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <FrameTitle className="min-w-0">
                  <span className="block truncate">{status.name}</span>
                </FrameTitle>
                <Badge variant="outline" size="sm" className="bg-background">
                  {tasks.length}
                </Badge>
              </div>
            </div>
          </div>
        </FrameHeader>

        <KanbanColumnContent value={status.id}>
          {tasks.map((task) => (
            <TaskCard key={task.path} task={task} context={context} isDone={isDone} />
          ))}
          <InlineAdd
            label={addLabel}
            dashed={tasks.length === 0}
            onAdd={(title) => onAddTask(status.id, title)}
            state={inlineAddState[status.id]}
            onStateChange={(state) => onInlineAddStateChange(status.id, state)}
            focused={focused}
          />
        </KanbanColumnContent>
      </Frame>
    </KanbanColumn>
  )
}

export interface KanbanBoardProps {
  statuses: readonly StatusDef[]
  /** The cards as drawn: the vault's, or the arrangement mid-drag. */
  value: Record<string, Task[]>
  onValueChange: (value: Record<string, Task[]>) => void
  onValueCommit: (value: Record<string, Task[]>, meta: KanbanCommitMeta<Task>) => void
  onDragEnd: () => void
  onDragCancel: () => void
  cancelDrop: () => boolean
  context: CardContext
  onAddTask: (status: string, title: string) => Promise<void>
  inlineAddState: Record<string, InlineAddState>
  onInlineAddStateChange: (status: string, state: InlineAddState) => void
  focused: boolean
  scrollPosition: BoardScrollPosition
  onScrollPositionChange: (position: BoardScrollPosition) => void
}

export function KanbanBoard({
  statuses,
  value,
  onValueChange,
  onValueCommit,
  onDragEnd,
  onDragCancel,
  cancelDrop,
  context,
  onAddTask,
  inlineAddState,
  onInlineAddStateChange,
  focused,
  scrollPosition,
  onScrollPositionChange,
}: KanbanBoardProps) {
  const scrollArea = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const viewport = scrollArea.current?.querySelector<HTMLElement>(
      '[data-radix-scroll-area-viewport]',
    )
    if (!viewport) return
    const frame = requestAnimationFrame(() => restoreBoardScroll(viewport, scrollPosition))
    return () => cancelAnimationFrame(frame)
  }, [onScrollPositionChange, scrollPosition])

  const find = (path: string) => {
    for (const [column, tasks] of Object.entries(value)) {
      const task = tasks.find((item) => item.path === path)
      if (task) return { column, task }
    }
    return null
  }

  return (
    <Kanban<Task>
      value={value}
      onValueChange={onValueChange}
      getItemValue={(item) => item.path}
      onValueCommit={onValueCommit}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
      cancelDrop={cancelDrop}
      restoreOnCancel
      // The board fills the pane and scrolls inside it, so the horizontal bar
      // holds the pane's foot however tall a column grows mid-drag.
      className="flex min-h-0 w-full flex-1 flex-col"
    >
      <ScrollArea
        ref={scrollArea}
        className="min-h-0 w-full min-w-0 flex-1"
        onScrollCapture={(event) => {
          if (event.target instanceof HTMLElement) {
            onScrollPositionChange(captureBoardScroll(event.target))
          }
        }}
      >
        <KanbanBoardPrimitive variant="row">
          {statuses.map((status) => (
            <StatusColumn
              key={status.id}
              status={status}
              tasks={value[status.id] ?? []}
              context={context}
              onAddTask={onAddTask}
              inlineAddState={inlineAddState}
              onInlineAddStateChange={onInlineAddStateChange}
              focused={focused}
            />
          ))}
        </KanbanBoardPrimitive>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>

      <KanbanOverlay>
        {({ value: path, variant }) => {
          if (variant === 'column') return null
          const found = find(String(path))
          if (!found) return null
          const status = statuses.find((s) => s.id === found.column)
          return (
            <TaskCard
              task={found.task}
              context={context}
              isOverlay
              isDone={status?.category === 'completed'}
            />
          )
        }}
      </KanbanOverlay>
    </Kanban>
  )
}
