import type { StatusDef, Task } from "@holi/shared"

/** A status's heading row; its tasks are its sub-rows. */
export interface TaskGroupRow {
  kind: "group"
  id: string
  status: StatusDef
  subRows: TaskTableRow[]
}

export interface TaskItemRow {
  kind: "task"
  id: string
  status: StatusDef
  task: Task
}

/** The List's "Add task" line at the foot of a group. */
export interface TaskAddRow {
  kind: "add"
  id: string
  status: StatusDef
}

export type TaskTableRow = TaskGroupRow | TaskItemRow | TaskAddRow

export type TaskColumnKey =
  "status" | "assignee" | "priority" | "due" | "start" | "estimate" | "tags"

export const COLUMN_LABELS: Record<TaskColumnKey, string> = {
  status: "Status",
  assignee: "Assignee",
  priority: "Priority",
  due: "Due",
  start: "Start",
  estimate: "Estimate",
  tags: "Tags",
}
