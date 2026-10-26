// ReUI block: @reui/data-grid-grouping-1 (`npx shadcn@latest view @reui/data-grid-grouping-1` shows the published source)
import { useMemo, useState, type ReactNode } from "react"
import type { StatusDef, Task } from "@holi/shared"
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

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { PanelBody } from "../planning-toolbar"
import { createTaskColumns, type TaskColumnsContext } from "./task-columns"
import {
  COLUMN_LABELS,
  type TaskColumnKey,
  type TaskGroupRow,
  type TaskTableRow,
} from "./task-rows"
import { Settings2Icon } from "lucide-react"

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
  /** Above the grid: the tab's alerts. */
  notices?: ReactNode
  /** In place of the grid, when the filters left nothing to show. */
  empty?: ReactNode
}

export function TaskGridView({
  variant,
  groups,
  toolbar,
  emptyMessage,
  notices,
  empty,
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
    // What is folded is ours: a search that changes the rows must not reset
    // it, which `setExpanded` would read as every group folded.
    autoResetExpanded: false,
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
        variant="ghost"
        size="sm"
        onClick={() => setExpanded(everyExpanded ? {} : allExpanded(rows))}
      >
        {everyExpanded ? "Collapse groups" : "Expand groups"}
      </Button>
      {variant === "table" ? (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="sm">
              <Settings2Icon data-icon="inline-start" aria-hidden="true" />
              Display
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Columns</DropdownMenuLabel>
              {keys.map((key) => (
                <DropdownMenuCheckboxItem
                  key={key}
                  checked={!hidden.includes(key)}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={() => toggle(key)}
                >
                  {COLUMN_LABELS[key]}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
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
        // Level with the toolbar above, now the grid runs to the pane's edge.
        edgeCell: "first:ps-4 last:pe-4 lg:first:ps-6 lg:last:pe-6",
      }}
    >
      <section className="flex min-h-0 w-full flex-1 flex-col">
        {toolbar(controls)}

        {empty !== undefined ? (
          <PanelBody>
            {notices}
            {empty}
          </PanelBody>
        ) : (
          <PanelBody flush>
            {notices != null ? (
              <div className="flex flex-col gap-4 px-4 py-4 lg:px-6">
                {notices}
              </div>
            ) : null}
            <DataGridContainer className="border-b">
              <DataGridScrollArea>
                <DataGridTable renderHeader={variant === "table"} />
              </DataGridScrollArea>
            </DataGridContainer>
          </PanelBody>
        )}
      </section>
    </DataGrid>
  )
}
