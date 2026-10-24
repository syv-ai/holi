/**
 * The turn's todo list (TodoWrite), one card redrawn in place as Claude Code
 * ticks it off: waiting, in progress (a spinner, still under reduced
 * motion) and done (checked and struck through). Its count is pinned to the
 * turn's header too ("2/3 done").
 *
 * After MonoCode's task list (`features/sessions/model/taskList.ts`, MIT,
 * Copyright (c) 2026 Nick; see NOTICE.md), on shadcn's card.
 */
import { CircleCheckIcon, CircleIcon } from "lucide-react"

import { Badge } from "@/components/reui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/plugin-api"
import type { TodoEntry, TranscriptItem } from "../../shared/chat"

/** "2/3 done", or "Done" once every item is. */
export function todoProgress(todos: readonly TodoEntry[]): string {
  const done = todos.filter((t) => t.status === "completed").length
  return done === todos.length && todos.length > 0
    ? "All done"
    : `${done}/${todos.length} done`
}

function Mark({ status }: { status: TodoEntry["status"] }) {
  if (status === "completed") {
    return (
      <CircleCheckIcon
        aria-hidden="true"
        className="text-success size-4 shrink-0"
      />
    )
  }
  if (status === "in_progress") {
    return (
      <Spinner
        aria-hidden="true"
        className="text-foreground size-4 shrink-0 motion-reduce:animate-none"
      />
    )
  }
  return (
    <CircleIcon
      aria-hidden="true"
      className="text-muted-foreground/60 size-4 shrink-0"
    />
  )
}

const SAID: Record<TodoEntry["status"], string> = {
  pending: "To do",
  in_progress: "In progress",
  completed: "Done",
}

export function TodoCard({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "todos" }>
}) {
  const done = item.todos.filter((t) => t.status === "completed").length
  return (
    <Card size="sm" data-todos={item.id}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Todo list
          <Badge
            variant={done === item.todos.length ? "success-light" : "secondary"}
            className="tabular-nums"
          >
            {todoProgress(item.todos)}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-1.5" aria-label="Todo list">
          {item.todos.map((t, i) => (
            <li
              key={`${i}-${t.text}`}
              className="flex min-w-0 items-start gap-2 text-sm"
            >
              <span className="flex h-5 items-center">
                <Mark status={t.status} />
              </span>
              <span className="sr-only">{SAID[t.status]}: </span>
              <span
                className={cn(
                  "min-w-0 break-words",
                  t.status === "completed" &&
                    "text-muted-foreground line-through",
                  t.status === "in_progress" && "text-foreground font-medium"
                )}
              >
                {t.status === "in_progress" && t.active !== undefined
                  ? t.active
                  : t.text}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
