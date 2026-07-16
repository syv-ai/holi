/** The task detail view (prd/tasks.md §Board UX).
 *
 * Everything the card deliberately does not carry. The card keeps exactly one
 * affordance — the complete checkbox — so it stays scannable; every other edit lands
 * here.
 *
 * Writes send **no `version`**: the board is plain last-writer-wins per field. The
 * concurrency token belongs to the *file* path, where the writer edited a snapshot of a
 * record that may have moved under them. Here the user is looking at the live record,
 * which the SSE push keeps current.
 */
import type {
  Priority,
  Recurrence,
  RecurrenceFrequency,
  RecurrenceWeekday,
  Task,
  TaskStatus,
} from '@holi/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef, useState } from 'react'
import {
  NO_AREA,
  completeTaskAtom,
  deleteTaskAtom,
  foldersAtom,
  heartbeatAtom,
  patchTaskAtom,
  resolveRelated,
  selectedTaskIdAtom,
  tasksAtom,
} from '../state/tasks'
import { docsAtom } from '../state/vaults'
import { openDocAtom } from '../state/view'

/** The server's presence TTL is 10s; beat well inside it while the user is typing.
 *
 * Driven by **edits, not focus** — merely having the panel open is not editing, and a
 * heartbeat on focus would light up a teammate's card because someone glanced at it.
 * When the typing stops, the beats stop, the entry expires, and that *is* the release:
 * there is no "stopped editing" event, and adding one would rebuild the whole lock
 * lifecycle presence exists to avoid.
 */
const BEAT_MS = 4000

function useEditHeartbeat(taskId: string): () => void {
  const beat = useSetAtom(heartbeatAtom)
  const last = useRef(0)
  return () => {
    const now = Date.now()
    if (now - last.current < BEAT_MS) return
    last.current = now
    beat(taskId) // fire-and-forget; never awaited into the write path
  }
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-20 shrink-0 text-neutral-500">{label}</span>
      {children}
    </label>
  )
}

const input =
  'min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs focus:border-neutral-700 focus:outline-none'

export function TaskDetail({ task }: { task: Task }): React.JSX.Element {
  const folders = useAtomValue(foldersAtom)
  const patch = useSetAtom(patchTaskAtom)
  const complete = useSetAtom(completeTaskAtom)
  const del = useSetAtom(deleteTaskAtom)
  const close = useSetAtom(selectedTaskIdAtom)
  const onEdit = useEditHeartbeat(task.id)

  // `description` is a plain column, NOT a CRDT doc — a plain textarea, debounced.
  // Character-merging it would drag the whole merge problem back in for the least
  // structured field of the least contended record.
  const [description, setDescription] = useState(task.description ?? '')
  const [title, setTitle] = useState(task.title)
  useEffect(() => setDescription(task.description ?? ''), [task.id, task.description])
  useEffect(() => setTitle(task.title), [task.id, task.title])

  const save = (p: Record<string, unknown>) => {
    onEdit()
    void patch(task.id, p)
  }

  // debounce the body: a keystroke-per-mutation would rewrite the task file (and, with
  // the mirror on, commit it) on every character
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onDescription = (v: string) => {
    setDescription(v)
    onEdit() // beat on the keystroke, not on the save
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void patch(task.id, { description: v === '' ? null : v }), 600)
  }
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  return (
    <aside
      data-task-detail={task.id}
      className="flex w-80 shrink-0 flex-col gap-2 overflow-y-auto border-l border-neutral-900 bg-neutral-950 p-3"
    >
      <div className="flex items-start gap-2">
        <input
          value={title}
          data-detail-title
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== task.title && save({ title: title.trim() })}
          className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm font-medium hover:border-neutral-800 focus:border-neutral-700 focus:outline-none"
        />
        <button
          onClick={() => close(null)}
          className="rounded px-1 text-neutral-500 hover:bg-neutral-900"
          title="close"
        >
          ✕
        </button>
      </div>

      <Row label="status">
        <select
          value={task.status}
          data-detail-status
          onChange={(e) => {
            const next = e.target.value as TaskStatus
            // Completion goes through tasks.complete even from here — it is the single
            // roll-forward path, so a recurring task rolls instead of persisting `done`.
            if (next === 'done') void complete(task.id)
            else save({ status: next })
          }}
          className={input}
        >
          <option value="todo">todo</option>
          <option value="doing">doing</option>
          <option value="done">done</option>
        </select>
      </Row>

      <Row label="area">
        <select
          value={task.area ?? ''}
          data-detail-area
          onChange={(e) => save({ area: e.target.value === '' ? null : e.target.value })}
          className={input}
        >
          {/* the record stores a folder ID; the UI shows the path */}
          <option value="">{NO_AREA}</option>
          {[...folders].map(([id, path]) => (
            <option key={id} value={id}>
              {path}
            </option>
          ))}
        </select>
      </Row>

      <Row label="due">
        <input
          type="date"
          value={task.due ?? ''}
          data-detail-due
          onChange={(e) => save({ due: e.target.value === '' ? null : e.target.value })}
          className={input}
        />
      </Row>

      <Row label="priority">
        <select
          value={task.priority ?? ''}
          data-detail-priority
          onChange={(e) => save({ priority: e.target.value === '' ? null : (e.target.value as Priority) })}
          className={input}
        >
          <option value="">—</option>
          <option value="high">high</option>
          <option value="medium">medium</option>
          <option value="low">low</option>
        </select>
      </Row>

      <Row label="tags">
        <input
          defaultValue={task.tags.join(', ')}
          key={`${task.id}:tags`}
          placeholder="comma, separated"
          onBlur={(e) =>
            save({
              tags: e.target.value
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean),
            })
          }
          className={input}
        />
      </Row>

      {/* The grammar goes in verbatim — the shared parser rejects bad input and its error
          string doubles as the format doc. No rule-builder UI. */}
      <Row label="reminder">
        <input
          defaultValue={task.reminder ?? ''}
          key={`${task.id}:reminder`}
          placeholder="1d | 2w | 2026-07-20T09:00"
          onBlur={(e) => save({ reminder: e.target.value.trim() === '' ? null : e.target.value.trim() })}
          className={input}
        />
      </Row>

      <RecurrenceRows task={task} save={save} />
      <RelatedRows task={task} save={save} />

      <textarea
        value={description}
        data-detail-description
        onChange={(e) => onDescription(e.target.value)}
        placeholder="description…"
        rows={8}
        className="mt-1 rounded border border-neutral-800 bg-neutral-900 p-2 text-xs placeholder:text-neutral-600 focus:border-neutral-700 focus:outline-none"
      />

      <button
        onClick={() => void del(task.id)}
        className="mt-auto self-start rounded px-1 py-0.5 text-xs text-red-400 hover:bg-red-950/50"
      >
        delete task
      </button>
    </aside>
  )
}

const WEEKDAYS: RecurrenceWeekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

/**
 * The recurrence rule. Recurrence and reminders are the two features that justify a task
 * being a server record at all, and until now the rule was reachable only by editing the
 * task's markdown file or by asking Claude — the same "the agent can, the button can't"
 * asymmetry the file tree had.
 *
 * A builder, unlike its sibling `reminder` directly above, which takes its grammar
 * verbatim and parses it. That is not inconsistency: a reminder IS a string (`1d`,
 * `2026-07-20T09:00`) with a parser whose error doubles as the format doc, while a
 * `Recurrence` is a **map** — `{frequency, interval, weekdays?, endDate?}` — with no text
 * form anywhere in `shared`. Inventing a grammar for it here would mean inventing a
 * parser too, and a second way to say something the model already says structurally.
 *
 * Roll-forward is the server's (`nextDueCatchup` on complete), so nothing here computes a
 * date; this only states the rule.
 */
function RecurrenceRows({
  task,
  save,
}: {
  task: Task
  save: (p: Record<string, unknown>) => void
}): React.JSX.Element {
  const rule = task.recurrence
  /** Patch the rule as a whole — the record holds one map, so a partial write would drop
   * the fields it did not mention. */
  const setRule = (next: Partial<Recurrence> | null) => {
    if (next === null) return save({ recurrence: null })
    save({ recurrence: { frequency: 'daily', interval: 1, ...rule, ...next } })
  }

  return (
    <>
      <Row label="repeats">
        <select
          value={rule?.frequency ?? ''}
          data-detail-recurrence
          onChange={(e) =>
            e.target.value === ''
              ? setRule(null)
              : setRule({ frequency: e.target.value as RecurrenceFrequency })
          }
          className={input}
        >
          <option value="">never</option>
          <option value="daily">daily</option>
          <option value="weekly">weekly</option>
          <option value="monthly">monthly</option>
          <option value="yearly">yearly</option>
        </select>
      </Row>

      {rule && (
        <>
          <Row label="every">
            <input
              type="number"
              min={1}
              value={rule.interval}
              data-detail-interval
              onChange={(e) => setRule({ interval: Math.max(1, Number(e.target.value) || 1) })}
              className={input}
            />
            <span className="shrink-0 text-neutral-500">
              {{ daily: 'days', weekly: 'weeks', monthly: 'months', yearly: 'years' }[rule.frequency]}
            </span>
          </Row>

          {/* Weekdays are a weekly-only field in the model, and an empty list means "no
              weekday constraint" — nextWeeklyWeekday returns null on an empty set, which
              would silently stop the recurrence. So none-selected is stored as absent. */}
          {rule.frequency === 'weekly' && (
            <Row label="on">
              <span className="flex flex-1 gap-0.5">
                {WEEKDAYS.map((d) => {
                  const on = rule.weekdays?.includes(d) ?? false
                  return (
                    <button
                      key={d}
                      data-detail-weekday={d}
                      onClick={() => {
                        const next = on
                          ? (rule.weekdays ?? []).filter((w) => w !== d)
                          : [...(rule.weekdays ?? []), d]
                        setRule({ weekdays: next.length ? WEEKDAYS.filter((w) => next.includes(w)) : undefined })
                      }}
                      className={`flex-1 rounded py-0.5 text-[10px] ${
                        on ? 'bg-neutral-700 text-neutral-100' : 'bg-neutral-900 text-neutral-500 hover:bg-neutral-800'
                      }`}
                    >
                      {d[0]}
                    </button>
                  )
                })}
              </span>
            </Row>
          )}

          <Row label="until">
            <input
              type="date"
              value={rule.endDate ?? ''}
              data-detail-recurrence-end
              onChange={(e) => setRule({ endDate: e.target.value === '' ? undefined : e.target.value })}
              className={input}
            />
          </Row>

          {/* A recurring task with no due date never rolls: nextDue needs one to advance
              from. Worth saying, because the rule looks set and simply would not fire. */}
          {task.due === undefined && (
            <p className="text-[10px] text-amber-400/80">
              Set a due date — a repeat has nothing to advance from without one.
            </p>
          )}
        </>
      )}
    </>
  )
}

/**
 * What this task is linked to. Read-and-unlink, deliberately not an editor.
 *
 * **No "add" control.** Relations are authored from the *other* side — `@`-mention a task
 * inside a note and the note lands in this list — and from the task file. A picker here
 * would be a third author for the same edge, and the one it would duplicate is the one
 * that already reads naturally.
 *
 * **Unlink exists because tombstones are permanent otherwise.** D27 means deleting a note
 * does not cascade, so a dangling ref stays until something removes it; without an × the
 * only way to clear one would be to hand-edit the task file.
 */
function RelatedRows({
  task,
  save,
}: {
  task: Task
  save: (p: Record<string, unknown>) => void
}): React.JSX.Element | null {
  const { docs } = useAtomValue(docsAtom)
  const tasks = useAtomValue(tasksAtom)
  const openDoc = useSetAtom(openDocAtom)
  const select = useSetAtom(selectedTaskIdAtom)
  if (task.related.length === 0) return null
  const refs = resolveRelated(task.related, docs, tasks)

  const unlink = (id: string) =>
    save({ related: task.related.filter((r) => r.id !== id).map((r) => ({ kind: r.kind, id: r.id })) })

  return (
    <div className="flex flex-col gap-1 text-xs">
      <span className="text-neutral-500">related</span>
      {refs.map((ref) => (
        <div key={`${ref.kind}:${ref.id}`} className="group flex items-center gap-1 pl-1">
          <span className="shrink-0 text-[10px] text-neutral-600">{ref.kind}</span>
          <button
            data-related-ref={ref.id}
            disabled={ref.missing || ref.kind === 'email' || ref.kind === 'event'}
            onClick={() => {
              if (ref.kind === 'note') {
                const doc = docs.find((d) => d.id === ref.id)
                if (doc) openDoc(doc)
              } else if (ref.kind === 'task') select(ref.id)
            }}
            className={`min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left ${
              ref.missing
                ? 'text-neutral-600 italic'
                : 'text-neutral-300 hover:bg-neutral-900 hover:text-neutral-100 disabled:hover:bg-transparent'
            }`}
          >
            {ref.label}
          </button>
          <button
            onClick={() => unlink(ref.id)}
            title={ref.missing ? 'remove this dead link' : 'unlink'}
            className="hidden shrink-0 px-1 text-[10px] text-neutral-600 hover:text-red-400 group-hover:block"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}

/** Renders the selected task, or nothing. */
export function TaskDetailPanel(): React.JSX.Element | null {
  const selectedId = useAtomValue(selectedTaskIdAtom)
  const tasks = useAtomValue(tasksAtom)
  const task = selectedId ? tasks.get(selectedId) : undefined
  // The task can vanish under the panel — a teammate deleted it, or `rm` on the file.
  return task ? <TaskDetail task={task} /> : null
}
