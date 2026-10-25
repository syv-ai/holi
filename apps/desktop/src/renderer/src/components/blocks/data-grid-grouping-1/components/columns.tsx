"use no memo"

import type { StatusDef, Task } from "@holi/shared"
import { Badge } from "@/components/reui/badge"
import { type DataGridFeatures } from "@/components/reui/data-grid/data-grid"
import { DataGridColumnHeader } from "@/components/reui/data-grid/data-grid-column-header"
import { type ColumnDef } from "@tanstack/react-table"
import { cn } from "@/lib/cn"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ArrowRightIcon, ChevronRightIcon } from "lucide-react"
import { InlineAdd } from "../../planning/inline-add"
import {
  DateBadge,
  EstimateBadge,
  PeopleStack,
  PriorityBadge,
  PrivateMark,
  StatusBadge,
  StatusIcon,
  TagBadges,
} from "../../planning/task-bits"
import {
  COLUMN_LABELS,
  type TaskGroupRow,
  type TaskItemRow,
  type TaskTableRow,
} from "./data"

export interface TaskColumnsContext {
  statuses: readonly StatusDef[]
  today: string
  isOverdue: (task: Task) => boolean
  onOpenTask: (path: string) => void
  onSetStatus: (task: Task, status: string) => void
  onAddTask: (status: string, title: string) => Promise<void>
}

function isTaskRow(row: TaskTableRow): row is TaskItemRow {
  return row.kind === "task"
}

function GroupExpandButton({
  label,
  expanded,
  onToggle,
}: {
  label: string
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
      aria-expanded={expanded}
      className="text-muted-foreground hover:text-foreground"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onToggle()
      }}
    >
      <ChevronRightIcon
        className={cn(
          "size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none rtl:-scale-x-100",
          expanded && "rotate-90"
        )}
        aria-hidden="true"
      />
    </Button>
  )
}

function GroupCell({
  row,
  expanded,
  onToggle,
}: {
  row: TaskGroupRow
  expanded: boolean
  onToggle: () => void
}) {
  const count = row.subRows.filter((r) => r.kind === "task").length
  return (
    <div data-task-row="group" className="flex min-w-0 items-center gap-1.5">
      <GroupExpandButton
        label={row.status.name}
        expanded={expanded}
        onToggle={onToggle}
      />
      <StatusIcon status={row.status} className="size-4" />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="text-foreground shrink-0 truncate text-sm font-medium">
          {row.status.name}
        </span>
        <Badge variant="outline" className="shrink-0 tabular-nums">
          {count}
        </Badge>
      </div>
    </div>
  )
}

function TaskTitleCell({
  task,
  isDone,
  onOpen,
}: {
  task: Task
  isDone: boolean
  onOpen: () => void
}) {
  return (
    <div data-task-row="task" className="flex min-w-0 items-center gap-3 ps-8">
      <button
        type="button"
        onClick={onOpen}
        className="group/task-title focus-visible:ring-ring/50 flex max-w-full min-w-0 items-center gap-1 rounded-sm text-start text-sm leading-5 font-medium outline-none focus-visible:ring-2"
      >
        <span
          data-slot="task-title"
          className={cn(
            "group-hover/task-title:text-primary text-foreground min-w-0 flex-1 truncate py-0.25 transition-colors",
            isDone && "text-muted-foreground line-through"
          )}
        >
          {task.title}
        </span>
        <PrivateMark path={task.path} />
        <ArrowRightIcon
          className="size-3 shrink-0 opacity-0 transition-opacity group-hover/task-title:opacity-100 rtl:-scale-x-100"
          aria-hidden="true"
        />
      </button>
    </div>
  )
}

/** The status, and a menu that moves the task to another one. */
function StatusCell({
  row,
  context,
}: {
  row: TaskItemRow
  context: TaskColumnsContext
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Status of ${row.task.title}: ${row.status.name}`}
          className="focus-visible:ring-ring/50 rounded-md outline-none focus-visible:ring-2"
        >
          <StatusBadge status={row.status} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        <DropdownMenuLabel>Move to</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={row.status.id}
          onValueChange={(status) => {
            if (status !== row.status.id) context.onSetStatus(row.task, status)
          }}
        >
          {context.statuses.map((status) => (
            <DropdownMenuRadioItem key={status.id} value={status.id}>
              <StatusIcon status={status} />
              {status.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A cell that draws only on a task row. */
function onTask(
  draw: (row: TaskItemRow) => React.ReactNode
): ColumnDef<DataGridFeatures, TaskTableRow>["cell"] {
  return ({ row }) => (isTaskRow(row.original) ? draw(row.original) : null)
}

export function createTaskColumns(
  context: TaskColumnsContext
): ColumnDef<DataGridFeatures, TaskTableRow>[] {
  const header =
    (title: string): ColumnDef<DataGridFeatures, TaskTableRow>["header"] =>
    ({ column }) => <DataGridColumnHeader title={title} column={column} />

  return [
    {
      accessorFn: (row) =>
        row.kind === "task" ? row.task.title : row.status.name,
      id: "task",
      header: header("Task"),
      cell: ({ row }) => {
        const original = row.original
        if (original.kind === "group") {
          return (
            <GroupCell
              row={original}
              expanded={row.getIsExpanded()}
              onToggle={row.getToggleExpandedHandler()}
            />
          )
        }
        if (original.kind === "add") {
          return (
            <div className="ps-6">
              <InlineAdd
                label={`Add task to ${original.status.name}`}
                onAdd={(title) => context.onAddTask(original.status.id, title)}
              />
            </div>
          )
        }
        return (
          <TaskTitleCell
            task={original.task}
            isDone={original.status.category === "completed"}
            onOpen={() => context.onOpenTask(original.task.path)}
          />
        )
      },
      enableHiding: false,
      enableSorting: false,
      minSize: 280,
      meta: { headerTitle: "Task", autoSize: true },
    },
    {
      id: "status",
      accessorFn: (row) => row.status.name,
      header: header(COLUMN_LABELS.status),
      cell: onTask((row) => <StatusCell row={row} context={context} />),
      size: 130,
      enableSorting: false,
      meta: { headerTitle: COLUMN_LABELS.status },
    },
    {
      id: "assignee",
      accessorFn: (row) => (isTaskRow(row) ? row.task.assignees.join(",") : ""),
      header: header(COLUMN_LABELS.assignee),
      cell: onTask((row) =>
        row.task.assignees.length > 0 ? (
          <PeopleStack logins={row.task.assignees} />
        ) : (
          <span className="text-muted-foreground text-xs">Unassigned</span>
        )
      ),
      size: 110,
      enableSorting: false,
      meta: { headerTitle: COLUMN_LABELS.assignee },
    },
    {
      id: "priority",
      accessorFn: (row) => (isTaskRow(row) ? (row.task.priority ?? "") : ""),
      header: header(COLUMN_LABELS.priority),
      cell: onTask((row) =>
        row.task.priority !== undefined ? (
          <PriorityBadge priority={row.task.priority} />
        ) : null
      ),
      size: 100,
      enableSorting: false,
      meta: { headerTitle: COLUMN_LABELS.priority },
    },
    {
      id: "due",
      accessorFn: (row) => (isTaskRow(row) ? (row.task.due ?? "") : ""),
      header: header(COLUMN_LABELS.due),
      cell: onTask((row) =>
        row.task.due !== undefined ? (
          <DateBadge
            stamp={row.task.due}
            today={context.today}
            overdue={context.isOverdue(row.task)}
            label="Due"
          />
        ) : null
      ),
      size: 100,
      enableSorting: false,
      meta: { headerTitle: COLUMN_LABELS.due },
    },
    {
      id: "start",
      accessorFn: (row) => (isTaskRow(row) ? (row.task.start ?? "") : ""),
      header: header(COLUMN_LABELS.start),
      cell: onTask((row) =>
        row.task.start !== undefined ? (
          <DateBadge
            stamp={row.task.start}
            today={context.today}
            label="Start"
          />
        ) : null
      ),
      size: 100,
      enableSorting: false,
      meta: { headerTitle: COLUMN_LABELS.start },
    },
    {
      id: "estimate",
      accessorFn: (row) => (isTaskRow(row) ? (row.task.estimate ?? "") : ""),
      header: header(COLUMN_LABELS.estimate),
      cell: onTask((row) =>
        row.task.estimate !== undefined ? (
          <EstimateBadge estimate={row.task.estimate} />
        ) : null
      ),
      size: 90,
      enableSorting: false,
      meta: { headerTitle: COLUMN_LABELS.estimate },
    },
    {
      id: "tags",
      accessorFn: (row) => (isTaskRow(row) ? row.task.tags.join(" ") : ""),
      header: header(COLUMN_LABELS.tags),
      cell: onTask((row) => (
        <div className="flex min-w-0 flex-wrap gap-1">
          <TagBadges tags={row.task.tags} />
        </div>
      )),
      size: 160,
      enableSorting: false,
      meta: { headerTitle: COLUMN_LABELS.tags },
    },
  ]
}
