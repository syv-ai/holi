// ReUI block: @reui/kanban-board-4 (`npx shadcn@latest view @reui/kanban-board-4` shows the published source)
/**
 * The board: kanban-board-4's columns, one Frame per status, holding
 * kanban-board-6's cards. The block's column grip is left out, since the
 * columns' order is `.holi/statuses.yaml`'s and the board does not write it.
 */
import { type ComponentProps, type ReactNode } from "react"
import type { StatusDef, Task } from "@holi/shared"
import { PlusIcon } from "lucide-react"

import { Badge } from "@/components/reui/badge"
import { Frame, FrameHeader, FrameTitle } from "@/components/reui/frame"
import {
  Kanban,
  KanbanBoard as KanbanBoardPrimitive,
  KanbanColumn,
  KanbanColumnContent,
  KanbanOverlay,
  type KanbanCommitMeta,
} from "@/components/reui/kanban"
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area"
import { cn } from "@/lib/cn"

import { Button } from "@/components/ui/button"
import { InlineAdd } from "../inline-add"
import { StatusIcon } from "../task-bits"
import {
  TaskCard,
  type CardContext,
} from "./task-card"

export type { CardContext }

function BoardScrollArea({ children }: { children: ReactNode }) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className="relative flex min-h-0 w-full min-w-0 flex-1 flex-col pb-3"
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className="focus-visible:ring-ring/50 h-full w-full rounded-lg transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:outline-1"
      >
        <ScrollAreaPrimitive.Content
          data-slot="scroll-area-content"
          className="flex min-w-full"
        >
          {children}
        </ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        data-slot="scroll-area-scrollbar"
        data-orientation="horizontal"
        orientation="horizontal"
        className="flex touch-none p-px transition-colors select-none data-horizontal:h-2.5 data-horizontal:flex-col data-horizontal:border-t data-horizontal:border-t-transparent data-vertical:h-full data-vertical:w-2.5 data-vertical:border-l data-vertical:border-l-transparent"
      >
        <ScrollAreaPrimitive.Thumb
          data-slot="scroll-area-thumb"
          className="bg-foreground/15 relative flex-1 rounded-full"
        />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

interface StatusColumnProps extends Omit<
  ComponentProps<typeof KanbanColumn>,
  "value" | "children"
> {
  status: StatusDef
  tasks: Task[]
  context: CardContext
  onAddTask: (status: string, title: string) => Promise<void>
  onNewTask: (status: string) => void
}

function StatusColumn({
  status,
  tasks,
  context,
  onAddTask,
  onNewTask,
  ...props
}: StatusColumnProps) {
  const isDone = status.category === "completed"
  const addLabel = `Add task to ${status.name}`

  return (
    <KanbanColumn
      value={status.id}
      data-column={status.id}
      className="w-[calc(100vw-4rem)] max-w-[18.5rem] shrink-0 sm:w-[18.5rem]"
      {...props}
    >
      <Frame
        spacing="sm"
        className="group/column"
        role="region"
        aria-label={`${status.name} tasks`}
      >
        <FrameHeader className="flex min-h-10 flex-row items-center gap-2 px-2 py-2">
          <StatusIcon status={status} className="size-4" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <FrameTitle className="truncate">{status.name}</FrameTitle>
              <Badge variant="outline" size="sm" className="bg-background">
                {tasks.length}
              </Badge>
            </div>
          </div>

          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`New task in ${status.name}`}
            onClick={() => onNewTask(status.id)}
            className="text-muted-foreground hover:text-foreground pointer-events-none opacity-0 transition-opacity group-focus-within/column:pointer-events-auto group-focus-within/column:opacity-100 group-hover/column:pointer-events-auto group-hover/column:opacity-100"
          >
            <PlusIcon aria-hidden="true" />
          </Button>
        </FrameHeader>

        <KanbanColumnContent value={status.id} className="gap-2 p-0.5">
          {tasks.map((task) => (
            <TaskCard
              key={task.path}
              task={task}
              context={context}
              isDone={isDone}
            />
          ))}
          <InlineAdd
            label={addLabel}
            dashed={tasks.length === 0}
            onAdd={(title) => onAddTask(status.id, title)}
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
  onValueCommit: (
    value: Record<string, Task[]>,
    meta: KanbanCommitMeta<Task>
  ) => void
  onDragEnd: () => void
  onDragCancel: () => void
  context: CardContext
  onAddTask: (status: string, title: string) => Promise<void>
  /** The column's +: the New task dialog, opening in that status. */
  onNewTask: (status: string) => void
}

export function KanbanBoard({
  statuses,
  value,
  onValueChange,
  onValueCommit,
  onDragEnd,
  onDragCancel,
  context,
  onAddTask,
  onNewTask,
}: KanbanBoardProps) {
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
      restoreOnCancel
      // The board fills the pane and scrolls inside it, so the horizontal bar
      // holds the pane's foot however tall a column grows mid-drag.
      className="flex min-h-0 w-full flex-1 flex-col"
    >
      <BoardScrollArea>
        <KanbanBoardPrimitive
          className={cn(
            "flex min-w-full items-start gap-3 p-1",
            "auto-rows-auto sm:grid-cols-none"
          )}
        >
          {statuses.map((status) => (
            <StatusColumn
              key={status.id}
              status={status}
              tasks={value[status.id] ?? []}
              context={context}
              onAddTask={onAddTask}
              onNewTask={onNewTask}
            />
          ))}
        </KanbanBoardPrimitive>
      </BoardScrollArea>

      <KanbanOverlay>
        {({ value: path, variant }) => {
          if (variant === "column") return null
          const found = find(String(path))
          if (!found) return null
          const status = statuses.find((s) => s.id === found.column)
          return (
            <TaskCard
              task={found.task}
              context={context}
              isOverlay
              isDone={status?.category === "completed"}
            />
          )
        }}
      </KanbanOverlay>
    </Kanban>
  )
}
