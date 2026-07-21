/** The task detail view (prd/tasks.md §Board UX).
 *
 * Everything the card deliberately does not carry. The card keeps exactly one
 * affordance — the complete checkbox — so it stays scannable; every other edit
 * lands here.
 *
 * Writes send **no `version`**: there is nothing to race with. On this machine
 * the file is the single writer target and the last write wins; between machines
 * git arbitrates, not a token.
 *
 * Two things that used to live here are gone with the server. **Presence** — its
 * heartbeat needed a push channel, and two people on one task file is now an
 * ordinary git conflict. **`related[]`** — a task links to things by writing
 * wiki-links in its body, so the description below is the relations editor.
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
  completeTaskAtom,
  deleteTaskAtom,
  laneLabel,
  laneOf,
  patchTaskAtom,
  selectedTaskPathAtom,
  tasksAtom,
} from '../state/tasks'

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
  const patch = useSetAtom(patchTaskAtom)
  const complete = useSetAtom(completeTaskAtom)
  const del = useSetAtom(deleteTaskAtom)
  const close = useSetAtom(selectedTaskPathAtom)

  // `description` is the file's markdown body — a plain textarea, debounced.
  const [description, setDescription] = useState(task.description)
  const [title, setTitle] = useState(task.title)
  useEffect(() => setDescription(task.description), [task.path, task.description])
  useEffect(() => setTitle(task.title), [task.path, task.title])

  const save = (p: Record<string, unknown>) => void patch(task.path, p)

  // Debounce the body: a keystroke-per-mutation would rewrite the task file — and,
  // once autosave commits land, commit it — on every character.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onDescription = (v: string) => {
    setDescription(v)
    if (timer.current) clearTimeout(timer.current)
    // Sent as '' rather than null: an empty body is the field's empty state, not
    // an absent field, and `parseTaskPatch` refuses to "clear" what cannot be unset.
    timer.current = setTimeout(() => void patch(task.path, { description: v }), 600)
  }
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  return (
    <aside
      data-task-detail={task.path}
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

      {/* The path, read-only. It is the task's identity and its lane, and it is not
          editable here: moving the file has to rewrite every inbound wiki-link in the
          same pass, which is the file tree's rename, not a text field. */}
      <p className="truncate font-mono text-[10px] text-neutral-600" title={task.path}>
        {laneLabel(laneOf(task))}
      </p>

      <Row label="status">
        <select
          value={task.status}
          data-detail-status
          onChange={(e) => {
            const next = e.target.value as TaskStatus
            // Completion goes through tasks.complete even from here — it is the single
            // roll-forward path, so a recurring task rolls instead of persisting `done`.
            if (next === 'done') void complete(task.path)
            else save({ status: next })
          }}
          className={input}
        >
          <option value="todo">todo</option>
          <option value="doing">doing</option>
          <option value="done">done</option>
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
          onChange={(e) =>
            save({ priority: e.target.value === '' ? null : (e.target.value as Priority) })
          }
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
          key={`${task.path}:tags`}
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
          key={`${task.path}:reminder`}
          placeholder="1d | 2w | 2026-07-20T09:00"
          onBlur={(e) =>
            save({ reminder: e.target.value.trim() === '' ? null : e.target.value.trim() })
          }
          className={input}
        />
      </Row>

      <RecurrenceRows task={task} save={save} />

      <textarea
        value={description}
        data-detail-description
        onChange={(e) => onDescription(e.target.value)}
        placeholder="description — [[wiki-links]] are how a task links to a note"
        rows={8}
        className="mt-1 rounded border border-neutral-800 bg-neutral-900 p-2 text-xs placeholder:text-neutral-600 focus:border-neutral-700 focus:outline-none"
      />

      <button
        onClick={() => void del(task.path)}
        className="mt-auto self-start rounded px-1 py-0.5 text-xs text-red-400 hover:bg-red-950/50"
      >
        delete task
      </button>
    </aside>
  )
}

const WEEKDAYS: RecurrenceWeekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

/**
 * The recurrence rule.
 *
 * A builder, unlike its sibling `reminder` directly above, which takes its grammar
 * verbatim and parses it. That is not inconsistency: a reminder IS a string (`1d`,
 * `2026-07-20T09:00`) with a parser whose error doubles as the format doc, while a
 * `Recurrence` is a **map** — `{frequency, interval, weekdays?, endDate?}` — with no text
 * form anywhere in `shared`. Inventing a grammar for it here would mean inventing a
 * parser too, and a second way to say something the model already says structurally.
 *
 * Roll-forward happens on complete (`nextDueCatchup`, in the router), so nothing here
 * computes a date; this only states the rule.
 */
function RecurrenceRows({
  task,
  save,
}: {
  task: Task
  save: (p: Record<string, unknown>) => void
}): React.JSX.Element {
  const rule = task.recurrence
  /** Patch the rule as a whole — the frontmatter holds one map, so a partial write
   * would drop the fields it did not mention. */
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
              {
                { daily: 'days', weekly: 'weeks', monthly: 'months', yearly: 'years' }[
                  rule.frequency
                ]
              }
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
                        setRule({
                          weekdays: next.length ? WEEKDAYS.filter((w) => next.includes(w)) : undefined,
                        })
                      }}
                      className={`flex-1 rounded py-0.5 text-[10px] ${
                        on
                          ? 'bg-neutral-700 text-neutral-100'
                          : 'bg-neutral-900 text-neutral-500 hover:bg-neutral-800'
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
              onChange={(e) =>
                setRule({ endDate: e.target.value === '' ? undefined : e.target.value })
              }
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

/** Renders the selected task, or nothing. */
export function TaskDetailPanel(): React.JSX.Element | null {
  const selectedPath = useAtomValue(selectedTaskPathAtom)
  const tasks = useAtomValue(tasksAtom)
  const task = selectedPath ? tasks.get(selectedPath) : undefined
  // The task can vanish under the panel — a teammate's pull landed a delete, or
  // someone ran `rm` on the file.
  return task ? <TaskDetail task={task} /> : null
}
