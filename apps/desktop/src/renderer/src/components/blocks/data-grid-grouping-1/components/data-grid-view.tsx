import { useMemo, useState, type ReactNode } from "react"
import type { StatusDef, Task } from "@holi/shared"
import { Badge } from "@/components/reui/badge"
import {
  DataGrid,
  DataGridContainer,
  dataGridFeatures,
} from "@/components/reui/data-grid/data-grid"
import { DataGridScrollArea } from "@/components/reui/data-grid/data-grid-scroll-area"
import { DataGridTable } from "@/components/reui/data-grid/data-grid-table"
import {
  useTable,
  type ColumnVisibilityState,
  type ExpandedState,
} from "@tanstack/react-table"
import { cn } from "@/lib/cn"

import { Button } from "@/components/ui/button"
import { FieldGroup } from "@/components/ui/field"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { createTaskColumns, type TaskColumnsContext } from "./columns"
import {
  COLUMN_LABELS,
  type TaskColumnKey,
  type TaskGroupRow,
  type TaskTableRow,
} from "./data"
import { CheckIcon, Settings2Icon } from "lucide-react"

/** List: headerless rows under collapsible status groups, with an Add task
 *  line in each. Table: the same groups under a header, every field a
 *  column, columns switched on and off from Display. */
export type TaskGridVariant = "list" | "table"

const VARIANT_COLUMNS: Record<TaskGridVariant, TaskColumnKey[]> = {
  list: ["status", "assignee", "priority", "due", "tags"],
  table: ["status", "priority", "assignee", "due", "start", "estimate", "tags"],
}

function buildRows(
  statuses: readonly StatusDef[],
  groups: Record<string, Task[]>,
  withAdd: boolean
): TaskGroupRow[] {
  return statuses.map((status) => ({
    kind: "group",
    id: `group:${status.id}`,
    status,
    subRows: [
      ...(groups[status.id] ?? []).map((task) => ({
        kind: "task" as const,
        id: task.path,
        status,
        task,
      })),
      ...(withAdd
        ? [{ kind: "add" as const, id: `add:${status.id}`, status }]
        : []),
    ],
  }))
}

function allExpanded(rows: TaskGroupRow[]): Record<string, boolean> {
  return Object.fromEntries(rows.map((row) => [row.id, true]))
}

function isExpanded(expanded: ExpandedState, rowId: string) {
  return expanded === true || expanded[rowId] === true
}

export interface TaskGridViewProps extends TaskColumnsContext {
  variant: TaskGridVariant
  /** Tasks by the status they show under, already narrowed and ordered. */
  groups: Record<string, Task[]>
  /** The toolbar above the grid, handed the grid's own controls to place. */
  toolbar: (controls: ReactNode) => ReactNode
  emptyMessage: string
}

export function TaskGridView({
  variant,
  groups,
  toolbar,
  emptyMessage,
  ...context
}: TaskGridViewProps) {
  const { statuses } = context
  const keys = VARIANT_COLUMNS[variant]
  const [hidden, setHidden] = useState<TaskColumnKey[]>([])
  const rows = useMemo(
    () => buildRows(statuses, groups, variant === "list"),
    [statuses, groups, variant]
  )
  // Kept as what is folded, so a status added later arrives open.
  const [collapsed, setCollapsed] = useState<string[]>([])
  const expanded = useMemo<Record<string, boolean>>(
    () =>
      Object.fromEntries(
        rows.map((row) => [row.id, !collapsed.includes(row.id)])
      ),
    [rows, collapsed]
  )
  const setExpanded = (next: ExpandedState) =>
    setCollapsed(
      rows.filter((row) => !isExpanded(next, row.id)).map((row) => row.id)
    )
  const everyExpanded = collapsed.length === 0
  const recordCount = Object.values(groups).reduce((n, g) => n + g.length, 0)

  const columnVisibility = useMemo<ColumnVisibilityState>(
    () =>
      Object.fromEntries(
        (Object.keys(COLUMN_LABELS) as TaskColumnKey[]).map((key) => [
          key,
          keys.includes(key) && !hidden.includes(key),
        ])
      ),
    [keys, hidden]
  )

  // `context` is a fresh object each render; its parts are what matter.
  const columns = useMemo(
    () => createTaskColumns(context),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      context.statuses,
      context.today,
      context.isOverdue,
      context.onOpenTask,
      context.onSetStatus,
      context.onAddTask,
    ]
  )

  const table = useTable({
    features: dataGridFeatures,
    // Every row rendered: the data is already the page.
    manualPagination: true,
    data: rows as TaskTableRow[],
    columns,
    getRowId: (row) => row.id,
    getSubRows: (row) => (row.kind === "group" ? row.subRows : undefined),
    getRowCanExpand: (row) => row.original.kind === "group",
    state: { columnVisibility, expanded },
    onExpandedChange: (updater) =>
      setExpanded(typeof updater === "function" ? updater(expanded) : updater),
  })

  const toggle = (key: TaskColumnKey) =>
    setHidden((current) =>
      current.includes(key)
        ? current.filter((k) => k !== key)
        : [...current, key]
    )

  const controls = (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setExpanded(everyExpanded ? {} : allExpanded(rows))}
      >
        {everyExpanded ? "Collapse groups" : "Expand groups"}
      </Button>
      {variant === "table" ? (
        <Popover>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" size="sm">
              <Settings2Icon data-icon="inline-start" aria-hidden="true" />
              Display
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[300px] p-0">
            <FieldGroup className="gap-3 px-3.5 py-3">
              <div className="flex flex-col gap-2">
                <div className="text-muted-foreground text-xs font-medium">
                  Display properties
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {keys.map((key) => {
                    const active = !hidden.includes(key)
                    return (
                      <Button
                        key={key}
                        type="button"
                        size="sm"
                        variant={active ? "secondary" : "outline"}
                        className={cn(
                          "rounded-full",
                          active && "border-foreground/10"
                        )}
                        aria-pressed={active}
                        onClick={() => toggle(key)}
                      >
                        {active ? (
                          <CheckIcon className="size-4" aria-hidden="true" />
                        ) : null}
                        {COLUMN_LABELS[key]}
                      </Button>
                    )
                  })}
                </div>
              </div>
            </FieldGroup>
          </PopoverContent>
        </Popover>
      ) : null}
    </>
  )

  return (
    <DataGrid
      table={table}
      recordCount={recordCount}
      emptyMessage={emptyMessage}
      tableLayout={{
        dense: true,
        rowBorder: true,
        headerSticky: variant === "table",
        columnsVisibility: false,
        columnsResizable: false,
        columnsMovable: false,
        width: "fixed",
      }}
      tableClassNames={{
        body: "[&>tr:has(>td:only-child:empty)]:hidden",
        bodyRow:
          "group/task-row [&>td]:h-9 [&:has([data-task-row=group])>td]:h-11 [&:has([data-task-row=group])>td]:bg-muted/45 [&:has([data-task-row=group])>td]:shadow-none [&:has([data-task-row=group])>td]:hover:bg-muted/45",
        edgeCell: "first:ps-3 last:pe-3 lg:first:ps-4 lg:last:pe-4",
      }}
    >
      <section className="flex min-h-0 w-full flex-1 flex-col gap-3">
        {toolbar(controls)}

        {/* Content */}
        <DataGridContainer className="border-b">
          <DataGridScrollArea>
            <DataGridTable renderHeader={variant === "table"} />
          </DataGridScrollArea>
        </DataGridContainer>

        {/* Footer */}
        <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
          <span className="text-foreground font-medium">By status</span>
          {statuses.map((status) => (
            <Badge key={status.id} variant="outline">
              {status.name}: {groups[status.id]?.length ?? 0}
            </Badge>
          ))}
        </div>
      </section>
    </DataGrid>
  )
}
