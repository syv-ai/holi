import { type ComponentProps, type ReactNode } from "react"
import type { StatusDef, Task } from "@holi/shared"
import {
  Kanban,
  KanbanBoard as KanbanBoardPrimitive,
  KanbanColumn,
  KanbanColumnContent,
  KanbanItem,
  KanbanItemHandle,
  KanbanOverlay,
  type KanbanCommitMeta,
} from "@/components/reui/kanban"
import { Badge } from "@/components/reui/badge"
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area"
import { cn } from "@/lib/cn"

import { Card, CardContent } from "@/components/ui/card"
import { ArrowRightIcon } from "lucide-react"
import { InlineAdd } from "../../planning/inline-add"
import {
  DateBadge,
  EstimateBadge,
  PeopleStack,
  PriorityBadge,
  StatusDot,
  TagBadges,
} from "../../planning/task-bits"
import { COLUMN_LOOKS } from "./data"

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
          className="w-max min-w-full"
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

function TaskTitleAffordance({
  title,
  isDone,
  onOpen,
}: {
  title: string
  isDone?: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group/task-title focus-visible:ring-ring/50 inline-flex max-w-full min-w-0 items-start gap-1 rounded-sm text-left outline-none focus-visible:ring-2"
    >
      <span
        data-slot="kanban-task-title"
        className={cn(
          "group-hover/task-title:text-primary line-clamp-2 py-0.25 transition-colors",
          isDone && "text-muted-foreground line-through"
        )}
      >
        {title}
      </span>
      <ArrowRightIcon
        className="mt-1 size-3 shrink-0 -translate-x-1 opacity-0 transition-[transform,opacity] group-hover/task-title:translate-x-0 group-hover/task-title:opacity-100"
        aria-hidden="true"
      />
    </button>
  )
}

/** What the board needs to draw one card. */
export interface CardContext {
  today: string
  isOverdue: (task: Task) => boolean
  onOpenTask: (path: string) => void
}

interface TaskCardProps extends Omit<
  ComponentProps<typeof KanbanItem>,
  "value" | "children"
> {
  task: Task
  context: CardContext
  asHandle?: boolean
  isOverlay?: boolean
  isDone?: boolean
}

function TaskCard({
  task,
  context,
  asHandle,
  isOverlay,
  isDone,
  ...props
}: TaskCardProps) {
  const overdue = context.isOverdue(task)
  const hasMeta =
    task.assignees.length > 0 ||
    task.due !== undefined ||
    task.estimate !== undefined
  const card = (
    <Card
      size="sm"
      data-task={task.path}
      className={cn(
        "bg-card hover:border-foreground/20 p-0 shadow-xs transition-[border-color,box-shadow] hover:shadow-sm",
        isOverlay && "shadow-lg",
        isDone && "bg-muted/40"
      )}
    >
      <CardContent className="flex flex-col gap-3 p-3">
        {task.tags.length > 0 || task.priority !== undefined ? (
          <div className="flex min-w-0 items-start justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <TagBadges tags={task.tags} />
            </div>
            {task.priority !== undefined ? (
              <PriorityBadge priority={task.priority} />
            ) : null}
          </div>
        ) : null}

        <h3 className="text-sm leading-5 font-medium">
          <TaskTitleAffordance
            title={task.title}
            isDone={isDone}
            onOpen={() => context.onOpenTask(task.path)}
          />
        </h3>

        {hasMeta ? (
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <PeopleStack logins={task.assignees} />
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {task.estimate !== undefined ? (
                <EstimateBadge estimate={task.estimate} />
              ) : null}
              {task.due !== undefined ? (
                <DateBadge
                  stamp={task.due}
                  today={context.today}
                  overdue={overdue}
                  label="Due"
                />
              ) : null}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )

  return (
    <KanbanItem value={task.path} {...props}>
      {asHandle && !isOverlay ? (
        <KanbanItemHandle className="block">{card}</KanbanItemHandle>
      ) : (
        card
      )}
    </KanbanItem>
  )
}

interface StatusColumnProps {
  status: StatusDef
  tasks: Task[]
  context: CardContext
  empty: ReactNode
  onAddTask: (status: string, title: string) => Promise<void>
}

function StatusColumn({
  status,
  tasks,
  context,
  empty,
  onAddTask,
}: StatusColumnProps) {
  const look = COLUMN_LOOKS[status.category]
  const isDone = status.category === "completed"

  return (
    <KanbanColumn
      value={status.id}
      data-column={status.id}
      className="w-[17.5rem] min-w-[17.5rem]"
    >
      <section
        className={cn(
          "flex min-h-[16rem] flex-col gap-2 rounded-lg border p-2.5 transition-colors",
          look.surfaceClassName,
          look.borderClassName
        )}
        aria-label={`${status.name} tasks`}
      >
        <div className="flex h-8 items-center gap-2 px-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <StatusDot status={status} />
            <h3 className="truncate text-sm font-semibold">{status.name}</h3>
            <Badge variant="outline" className="bg-background tabular-nums">
              {tasks.length}
            </Badge>
          </div>
        </div>

        <KanbanColumnContent value={status.id} className="min-h-28 gap-2">
          {tasks.length > 0 ? (
            tasks.map((task) => (
              <TaskCard
                key={task.path}
                task={task}
                context={context}
                asHandle
                isDone={isDone}
              />
            ))
          ) : (
            <div
              className={cn(
                "border-border/70 text-muted-foreground bg-background/55 rounded-lg border border-dashed px-3 py-6 text-center text-xs transition-colors",
                look.addClassName
              )}
            >
              {empty}
            </div>
          )}
        </KanbanColumnContent>

        <InlineAdd
          label={`Add task to ${status.name}`}
          onAdd={(title) => onAddTask(status.id, title)}
        />
      </section>
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
  /** What an empty column says. */
  emptyLabel: string
  onAddTask: (status: string, title: string) => Promise<void>
}

export function KanbanBoard({
  statuses,
  value,
  onValueChange,
  onValueCommit,
  onDragEnd,
  onDragCancel,
  context,
  emptyLabel,
  onAddTask,
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
      className="flex min-h-0 w-full min-w-0 flex-1 flex-col"
    >
      <BoardScrollArea>
        <KanbanBoardPrimitive className="grid min-w-max auto-cols-[17.5rem] grid-flow-col grid-cols-none items-start gap-3 px-1 pb-2">
          {statuses.map((status) => (
            <StatusColumn
              key={status.id}
              status={status}
              tasks={value[status.id] ?? []}
              context={context}
              empty={emptyLabel}
              onAddTask={onAddTask}
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
