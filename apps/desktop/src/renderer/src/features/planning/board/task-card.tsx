// ReUI block: @reui/kanban-board-6 (`npx shadcn@latest view @reui/kanban-board-6` shows the published source)
/**
 * A task on the board: kanban-board-6's ticket card, carrying a task file.
 * The ticket's key line holds the task's tags, its SLA chip the due date
 * (overdue reads as the block's breach risk, due within two days as its
 * watch), and its assignee line the first person the task is for.
 */
import type { ComponentProps } from "react"
import type { Task } from "@holi/shared"
import { ClockIcon } from "lucide-react"

import { KanbanItem, KanbanItemHandle } from "@/components/reui/kanban"
import { cn } from "@/lib/cn"
import { PersonAvatar } from "@/composites/person-avatar"
import { PriorityBadge, PrivateMark } from "../task-bits"
import { daysUntil, shortDate } from "@/lib/planning"

import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemHeader,
  ItemTitle,
} from "@/components/ui/item"

type DueState = "normal" | "watch" | "risk" | "cleared"

const DUE_STATE_CLASSNAME: Record<DueState, string> = {
  normal:
    "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300",
  watch:
    "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-400/35 dark:bg-amber-400/10 dark:text-amber-300",
  risk: "border-red-300 bg-red-50 text-red-700 dark:border-red-400/35 dark:bg-red-400/10 dark:text-red-300",
  cleared:
    "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/35 dark:bg-emerald-400/10 dark:text-emerald-300",
}

/** The chip's name, worded like `DateBadge`'s everywhere else. */
const DUE_STATE_LABEL: Record<DueState, (date: string) => string> = {
  normal: (date) => `Due ${date}`,
  watch: (date) => `Due ${date}, soon`,
  risk: (date) => `Due ${date}, overdue`,
  cleared: (date) => `Was due ${date}`,
}

const CARD_STATE_CLASSNAME: Record<DueState, string> = {
  normal: "",
  watch: "border-amber-300/70 dark:border-amber-400/35",
  risk: "border-red-300/90 bg-red-50/20 dark:border-red-400/40 dark:bg-red-950/10",
  cleared: "",
}

const TASK_TITLE_CLASSNAME =
  "line-clamp-2 w-auto text-sm leading-5 font-semibold"

const TASK_KEY_CLASSNAME =
  "text-muted-foreground text-[0.6875rem] leading-none font-medium"

/** What the board needs to draw one card. */
export interface CardContext {
  today: string
  isOverdue: (task: Task) => boolean
  onOpenTask: (path: string) => void
}

function dueState(task: Task, context: CardContext, isDone: boolean) {
  if (isDone) return "cleared"
  if (context.isOverdue(task)) return "risk"
  const days =
    task.due !== undefined ? daysUntil(context.today, task.due) : null
  return days !== null && days <= 2 ? "watch" : "normal"
}

function DueChip({
  due,
  state,
  today,
  className,
}: {
  due: string
  state: DueState
  today: string
  className?: string
}) {
  const date = shortDate(due, today)
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[0.6875rem] leading-none font-medium",
        DUE_STATE_CLASSNAME[state],
        className
      )}
      aria-label={DUE_STATE_LABEL[state](date)}
    >
      <ClockIcon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="shrink-0 font-semibold tabular-nums">{date}</span>
    </span>
  )
}

function AssigneeLine({ logins }: { logins: readonly string[] }) {
  const [login] = logins
  if (login === undefined) {
    return (
      <div className="text-muted-foreground min-w-0 truncate text-xs">
        Unassigned
      </div>
    )
  }
  const rest = logins.length - 1
  return (
    <div
      className="flex min-w-0 items-center gap-1.5"
      aria-label={logins.join(", ")}
    >
      <PersonAvatar login={login} alt="" className="size-5" />
      <div className="min-w-0 truncate text-xs font-medium" aria-hidden="true">
        {login}
        {rest > 0 ? (
          <span className="text-muted-foreground tabular-nums"> +{rest}</span>
        ) : null}
      </div>
    </div>
  )
}

/** The block's description line: when the task starts and how big it is. */
function planLine(task: Task, today: string): string | null {
  const parts = [
    task.start !== undefined ? `Starts ${shortDate(task.start, today)}` : null,
    task.estimate ?? null,
  ].filter((part) => part !== null)
  return parts.length > 0 ? parts.join(" · ") : null
}

function TaskItem({
  task,
  context,
  isDone,
  isOverlay,
}: {
  task: Task
  context: CardContext
  isDone: boolean
  isOverlay?: boolean
}) {
  const state = dueState(task, context, isDone)
  const plan = planLine(task, context.today)
  return (
    <Item
      variant="outline"
      size="sm"
      data-task={task.path}
      className={cn(
        "bg-card hover:border-foreground/20 items-stretch gap-3 transition-colors hover:shadow-sm",
        task.due !== undefined && CARD_STATE_CLASSNAME[state],
        isOverlay && "shadow-lg"
      )}
    >
      <ItemHeader className="min-w-0 flex-col items-stretch gap-1.5">
        {task.tags.length > 0 || task.priority !== undefined ? (
          <div className="flex min-w-0 items-center justify-between gap-2">
            <ItemDescription className={cn(TASK_KEY_CLASSNAME, "truncate")}>
              {task.tags.join(" · ")}
            </ItemDescription>

            {task.priority !== undefined ? (
              <ItemActions className="shrink-0">
                <PriorityBadge priority={task.priority} />
              </ItemActions>
            ) : null}
          </div>
        ) : null}

        <ItemContent className="min-w-0 gap-1">
          <ItemTitle className={TASK_TITLE_CLASSNAME}>
            {/* The title opens the task; the rest of the card drags it. */}
            <button
              type="button"
              onClick={() => context.onOpenTask(task.path)}
              className={cn(
                "focus-visible:ring-ring/50 hover:text-primary rounded-sm text-start transition-colors outline-none focus-visible:ring-2",
                isDone && "text-muted-foreground line-through"
              )}
            >
              {task.title}
            </button>
            <PrivateMark path={task.path} />
          </ItemTitle>
          {plan !== null ? (
            <ItemDescription className="line-clamp-1 text-xs">
              {plan}
            </ItemDescription>
          ) : null}
        </ItemContent>
      </ItemHeader>

      <ItemFooter className="min-w-0 items-center gap-3">
        <AssigneeLine logins={task.assignees} />
        {task.due !== undefined ? (
          <DueChip
            due={task.due}
            state={state}
            today={context.today}
            className="ml-auto"
          />
        ) : null}
      </ItemFooter>
    </Item>
  )
}

interface TaskCardProps extends Omit<
  ComponentProps<typeof KanbanItem>,
  "value" | "children"
> {
  task: Task
  context: CardContext
  isDone?: boolean
  isOverlay?: boolean
}

export function TaskCard({
  task,
  context,
  isDone = false,
  isOverlay,
  ...props
}: TaskCardProps) {
  const item = (
    <TaskItem
      task={task}
      context={context}
      isDone={isDone}
      isOverlay={isOverlay}
    />
  )

  return (
    <KanbanItem value={task.path} {...props}>
      {isOverlay ? (
        item
      ) : (
        <KanbanItemHandle className="block">{item}</KanbanItemHandle>
      )}
    </KanbanItem>
  )
}
