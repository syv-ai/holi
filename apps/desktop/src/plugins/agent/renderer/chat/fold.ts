/**
 * A conversation's entries folded into what the chat draws (docs/features/
 * agent-sessions.md, The chat): each tool's result joined to its call, a
 * background task's report joined to the call that started it, and the agent's
 * task list rebuilt from its TaskCreate/TaskUpdate calls. Pure: no React, so
 * the rules are testable and a refresh can be cheap.
 *
 * The rules come from how Claude Code writes a transcript:
 *  - Parallel calls interleave, so a result can come before a sibling's call
 *    and results come out of the calls' order. A result is paired with its
 *    call by id and never by position, hence two passes: index, then apply.
 *  - A result may name a call that is in an earlier part of the file not read
 *    yet. It is drawn as an `orphan` and completes once that part is loaded.
 *  - A re-read (a resume replays the conversation) repeats entries. One entry
 *    of each `kind:id` is kept, the first.
 *  - Agent, Workflow and Monitor answer with a launch acknowledgement; the
 *    real outcome arrives later as a `task-note`, joined by `toolUseId`.
 *
 * Identity: a refresh every second over thousands of entries must not redraw
 * every row. An item that did not change is the same object as last time
 * (`FoldCache`), so a memoised row skips; only the changed tool is new.
 */
import type { ChatEntry, ChatItem, TaskState, ToolItem, ToolResult, ToolState } from './items'

type Of<K extends ChatEntry['kind']> = Extract<ChatEntry, { kind: K }>

/** What the last fold left, for the next to reuse. Opaque to callers. */
export interface FoldCache {
  /** Every item by its key, with what it was built from. */
  readonly recs: ReadonlyMap<string, Rec>
  readonly items: readonly ChatItem[]
  readonly tasks: ReadonlyMap<string, TaskState>
}

interface Rec {
  item: ChatItem
  /** Tool items only: the parts the item was joined from. */
  call?: Of<'tool'> | undefined
  result?: Of<'tool-result'> | undefined
  note?: Of<'task-note'> | undefined
}

export interface Folded {
  items: ChatItem[]
  tasks: Map<string, TaskState>
  cache: FoldCache
}

const REJECTED = /^\s*The user doesn't want to proceed/i

/** Where a call stands. The entry after a result is the person's interrupt
 *  when they stopped it during the tool (a refused permission is the usual
 *  case); only a failed result can have been refused. */
function toolState(result: Of<'tool-result'> | undefined, next: ChatEntry | undefined): ToolState {
  if (result === undefined) return 'pending'
  if (result.ok === false) {
    if (REJECTED.test(result.text)) return 'rejected'
    if (next?.kind === 'interrupt' && next.forTool) return 'rejected'
    return 'error'
  }
  return 'done'
}

const sameResult = (a: Of<'tool-result'> | undefined, b: Of<'tool-result'> | undefined): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.ok === b.ok &&
    a.text.length === b.text.length &&
    a.clipped === b.clipped &&
    (a.images?.length ?? 0) === (b.images?.length ?? 0) &&
    a.data === b.data)

const sameNote = (a: Of<'task-note'> | undefined, b: Of<'task-note'> | undefined): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.status === b.status &&
    a.summary === b.summary &&
    a.taskId === b.taskId)

const sameCall = (a: Of<'tool'> | undefined, b: Of<'tool'> | undefined): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.name === b.name &&
    a.summary === b.summary &&
    a.args === b.args &&
    a.clipped === b.clipped)

/** Two entries of one kind and id with the same fields. */
function sameEntry(a: ChatItem, b: ChatEntry): boolean {
  if (a === b) return true
  const ra = a as unknown as Record<string, unknown>
  const rb = b as unknown as Record<string, unknown>
  const keys = Object.keys(ra)
  if (keys.length !== Object.keys(rb).length) return false
  return keys.every((k) => ra[k] === rb[k])
}

const asResult = (entry: Of<'tool-result'>): ToolResult => {
  const { kind: _kind, id: _id, ...rest } = entry
  return rest
}

/**
 * The entries as the chat draws them. `prev` is the cache of the last fold of
 * (an earlier state of) the same conversation; pass none for a new one.
 */
export function foldEntries(entries: readonly ChatEntry[], prev?: FoldCache): Folded {
  // Pass 1: index. First entry of each kind:id wins.
  const calls = new Map<string, Of<'tool'>>()
  const results = new Map<string, { entry: Of<'tool-result'>; next: ChatEntry | undefined }>()
  const notes = new Map<string, Of<'task-note'>>()
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    if (entry.kind === 'tool') {
      if (!calls.has(entry.id)) calls.set(entry.id, entry)
    } else if (entry.kind === 'tool-result') {
      if (!results.has(entry.id)) results.set(entry.id, { entry, next: entries[i + 1] })
    } else if (entry.kind === 'task-note' && entry.toolUseId !== undefined) {
      // The latest report on a call is the one that tells how it ended.
      notes.set(entry.toolUseId, entry)
    }
  }

  // Pass 2: the items, in the order the entries came.
  const before = prev?.recs
  const recs = new Map<string, Rec>()
  const items: ChatItem[] = []
  let changed = false

  const place = (key: string, rec: Rec): void => {
    recs.set(key, rec)
    items.push(rec.item)
    if (prev?.items[items.length - 1] !== rec.item) changed = true
  }

  const tool = (key: string, id: string, call: Of<'tool'> | undefined): void => {
    if (recs.has(key)) return
    const hit = results.get(id)
    const note = notes.get(id)
    const state = toolState(hit?.entry, hit?.next)
    const orphan = call === undefined
    const old = before?.get(key)
    if (
      old !== undefined &&
      old.item.kind === 'tool' &&
      old.item.state === state &&
      (old.item.orphan === true) === orphan &&
      sameCall(old.call, call) &&
      sameResult(old.result, hit?.entry) &&
      sameNote(old.note, note)
    ) {
      place(key, old)
      return
    }
    const item: ToolItem = call
      ? { ...call, state }
      : { kind: 'tool', id, name: 'result', summary: '', args: {}, state, orphan: true }
    if (hit !== undefined) item.result = asResult(hit.entry)
    if (note !== undefined) item.note = note
    place(key, { item, call, result: hit?.entry, note })
  }

  const plain = (entry: ChatEntry): void => {
    const key = `${entry.kind}:${entry.id}`
    if (recs.has(key)) return
    const old = before?.get(key)
    place(key, {
      item: old !== undefined && sameEntry(old.item, entry) ? old.item : (entry as ChatItem),
    })
  }

  for (const entry of entries) {
    if (entry.kind === 'tool') tool(`tool:${entry.id}`, entry.id, calls.get(entry.id))
    // Its call is somewhere: the call's own place draws it.
    else if (entry.kind === 'tool-result') {
      if (!calls.has(entry.id)) tool(`tool:${entry.id}`, entry.id, undefined)
    } else if (
      entry.kind === 'task-note' &&
      entry.toolUseId !== undefined &&
      (calls.has(entry.toolUseId) || results.has(entry.toolUseId))
    ) {
      // Joined to its call; a report on a call that is not here is its own row.
    } else plain(entry)
  }

  if (prev !== undefined && prev.items.length !== items.length) changed = true
  const tasks = foldTasks(items, prev?.tasks)
  return {
    items: changed || prev === undefined ? items : (prev.items as ChatItem[]),
    tasks,
    cache: { recs, items: changed || prev === undefined ? items : prev.items, tasks },
  }
}

// ---------------------------------------------------------------------------
// The agent's task list

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

/** A task id as a string, from a string or a number; undefined for the rest. */
function taskId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string') {
    const trimmed = value.trim().replace(/^#/, '')
    return trimmed === '' ? undefined : trimmed
  }
  return undefined
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/** The id TaskCreate gave a task: in the structured result, else in its text
 *  ("Task #3 created successfully: ..."). */
function createdId(tool: ToolItem): string | undefined {
  const result = tool.result
  if (result === undefined || !result.ok) return undefined
  const fromData = taskId(record(result.data?.['task'])?.['id'])
  if (fromData !== undefined) return fromData
  return /#(\w+)/.exec(result.text)?.[1]
}

/**
 * The task list as the calls left it, in the order they were made. A task is
 * created by TaskCreate once it has its id (from the result), changed by
 * TaskUpdate, and removed by an update to `deleted`. TodoWrite replaces its
 * list whole. A call that failed or was refused changed nothing, and a call
 * whose arguments are not the shape expected is ignored.
 */
function foldTasks(
  items: readonly ChatItem[],
  prev: ReadonlyMap<string, TaskState> | undefined,
): Map<string, TaskState> {
  const tasks = new Map<string, TaskState>()
  for (const item of items) {
    if (item.kind !== 'tool' || item.state === 'error' || item.state === 'rejected') continue
    const args = record(item.args)
    if (args === undefined) continue
    if (item.name === 'TaskCreate') {
      const id = createdId(item)
      const subject =
        text(args['subject']) ?? text(record(item.result?.data?.['task'])?.['subject'])
      if (id !== undefined && subject !== undefined)
        tasks.set(id, { id, subject, status: 'pending' })
    } else if (item.name === 'TaskUpdate') {
      const id = taskId(args['taskId'] ?? args['id'])
      if (id === undefined) continue
      const status = text(args['status'])
      if (status === 'deleted') {
        tasks.delete(id)
        continue
      }
      const old = tasks.get(id)
      const subject = text(args['subject']) ?? old?.subject ?? `Task ${id}`
      // An update to a task made in the part not loaded yet still shows.
      tasks.set(id, { id, subject, status: status ?? old?.status ?? 'pending' })
    } else if (item.name === 'TodoWrite') {
      const todos = args['todos']
      if (!Array.isArray(todos)) continue
      for (const key of [...tasks.keys()]) if (key.startsWith('todo-')) tasks.delete(key)
      todos.forEach((todo, index) => {
        const t = record(todo)
        const subject = text(t?.['content']) ?? text(t?.['subject'])
        if (subject === undefined) return
        const id = `todo-${index + 1}`
        tasks.set(id, { id, subject, status: text(t?.['status']) ?? 'pending' })
      })
    }
  }
  return prev !== undefined && sameTasks(prev, tasks) ? (prev as Map<string, TaskState>) : tasks
}

function sameTasks(a: ReadonlyMap<string, TaskState>, b: ReadonlyMap<string, TaskState>): boolean {
  if (a.size !== b.size) return false
  let i = 0
  const ai = [...a.values()]
  for (const t of b.values()) {
    const o = ai[i++]!
    if (o.id !== t.id || o.subject !== t.subject || o.status !== t.status) return false
  }
  return true
}
