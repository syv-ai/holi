/**
 * TaskCreate, TaskUpdate and TodoWrite: a slim checklist row. A task is
 * stateful across calls, so the glyph shows where the task stands NOW (the
 * conversation's task list by id), not what this one call did to it.
 */
import { Circle, CircleCheck, CircleDot, ListChecks } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Icon } from '@/primitives'
import { cn } from '@/plugin-api'
import type { ChatContext, ToolItem } from '../../../../../agent/renderer/chat/items'
import type { ToolRenderer } from '../registry'
import { argsOf, dataOf, firstStr, get, recs, str, textOf } from './coerce'
import { Caption, Markdown, Stack } from './parts'
import { stateOf, verb, type CardView } from './view'

type Phase = 'pending' | 'doing' | 'done'

function phaseOf(status: string | undefined): Phase {
  const s = (status ?? '').toLowerCase().replace(/[\s-]/g, '_')
  if (s === 'completed' || s === 'complete' || s === 'done') return 'done'
  if (s === 'in_progress' || s === 'doing' || s === 'active') return 'doing'
  return 'pending'
}

const GLYPH: Record<Phase, { icon: LucideIcon; tone: string; label: string }> = {
  pending: { icon: Circle, tone: 'text-task-todo', label: 'to do' },
  doing: { icon: CircleDot, tone: 'text-task-doing', label: 'in progress' },
  done: { icon: CircleCheck, tone: 'text-task-done', label: 'done' },
}

function lookup(ctx: ChatContext, id: string | undefined) {
  if (id === undefined || typeof ctx?.tasks?.get !== 'function') return undefined
  return ctx.tasks.get(id)
}

/** The task's id: from the structured result, else "Task #3 created". */
function taskIdOf(item: ToolItem): string | undefined {
  const args = argsOf(item)
  const data = dataOf(item)
  const fromArgs = firstStr(args, ['taskId', 'task_id', 'id'])
  if (fromArgs !== undefined) return fromArgs
  const task = get(data, 'task')
  const fromTask = firstStr(task, ['id'])
  if (fromTask !== undefined) return fromTask
  const direct = str(get(data, 'taskId'))
  if (direct !== undefined) return direct
  const m = /#([A-Za-z0-9_-]+)/.exec(textOf(item))
  return m?.[1]
}

export const taskCreateRenderer: ToolRenderer = (item, ctx) => {
  const args = argsOf(item)
  const data = dataOf(item)
  const subject = firstStr(args, ['subject', 'title']) ?? firstStr(get(data, 'task'), ['subject'])
  if (subject === undefined) return null
  const id = taskIdOf(item)
  const task = lookup(ctx, id)
  const phase = phaseOf(task?.status)
  const description = firstStr(args, ['description'])
  const chips: string[] = []
  if (id !== undefined) chips.push(`#${id}`)
  if (task !== undefined && phase !== 'pending') chips.push(GLYPH[phase].label)
  const view: CardView = {
    label: verb(item, 'Adding task', 'Added task'),
    icon: GLYPH[phase].icon,
    iconClass: GLYPH[phase].tone,
    summary: subject,
    chips,
    body: description === undefined ? null : <Markdown text={description} lines={12} chars={800} />,
  }
  return view
}

export const taskUpdateRenderer: ToolRenderer = (item, ctx) => {
  const args = argsOf(item)
  const data = dataOf(item)
  const id = taskIdOf(item)
  const status = firstStr(args, ['status'])
  if (id === undefined && status === undefined) return null
  const task = lookup(ctx, id)
  // Where it stands now; failing that, where this call put it.
  const now = task?.status ?? firstStr(get(data, 'statusChange'), ['to']) ?? status
  const phase = phaseOf(now)
  const subject =
    task?.subject ?? firstStr(args, ['subject']) ?? (id === undefined ? '' : `Task #${id}`)
  const from = firstStr(get(data, 'statusChange'), ['from'])
  const to = firstStr(get(data, 'statusChange'), ['to']) ?? status
  const chips: string[] = []
  if (from !== undefined && to !== undefined)
    chips.push(`${from.replace(/_/g, ' ')} → ${to.replace(/_/g, ' ')}`)
  else if (to !== undefined) chips.push(to.replace(/_/g, ' '))
  const description = firstStr(args, ['description'])
  const view: CardView = {
    label: verb(item, 'Updating task', 'Updated task'),
    icon: GLYPH[phase].icon,
    iconClass: GLYPH[phase].tone,
    summary: subject,
    chips,
    body: description === undefined ? null : <Markdown text={description} lines={12} chars={800} />,
  }
  return view
}

interface Todo {
  text: string
  phase: Phase
  active: string | undefined
}

function todosOf(item: ToolItem): Todo[] {
  const args = argsOf(item)
  return recs(args.todos).map((t) => ({
    text: firstStr(t, ['content', 'subject', 'text', 'title']) ?? '',
    phase: phaseOf(firstStr(t, ['status'])),
    active: firstStr(t, ['activeForm']),
  }))
}

export const todoWriteRenderer: ToolRenderer = (item) => {
  const todos = todosOf(item)
  if (todos.length === 0) return null
  const done = todos.filter((t) => t.phase === 'done').length
  const doing = todos.find((t) => t.phase === 'doing')
  const view: CardView = {
    label: verb(item, 'Planning', 'Plan'),
    icon: ListChecks,
    summary: doing !== undefined ? (doing.active ?? doing.text) : `${done} of ${todos.length} done`,
    chips: [`${done}/${todos.length}`],
    body: (
      <Stack>
        <ul className="flex flex-col gap-0.5 text-xs" data-chat-todos="">
          {todos.slice(0, 20).map((todo, i) => (
            <li key={i} className="flex items-center gap-2" data-todo-phase={todo.phase}>
              <Icon icon={GLYPH[todo.phase].icon} size="sm" className={GLYPH[todo.phase].tone} />
              <span
                className={cn(
                  'min-w-0',
                  todo.phase === 'done' && 'text-muted-foreground line-through',
                )}
              >
                {todo.text}
              </span>
            </li>
          ))}
        </ul>
        {todos.length > 20 && <Caption>{`${todos.length - 20} more`}</Caption>}
      </Stack>
    ),
  }
  return view
}
