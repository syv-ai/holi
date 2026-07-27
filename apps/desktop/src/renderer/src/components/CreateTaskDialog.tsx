import type { Priority, Recurrence, Task, TaskStatus } from '@holi/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { useMemo, useState } from 'react'
import {
  type CreateTaskMode,
  ROOT_LANE,
  createTaskAtom,
  laneLabel,
  patchTaskAtom,
  taskCreateFolders,
} from '../state/tasks'
import { openTaskAtom } from '../state/view'
import { activeDocAtom, snapshotAtom } from '../state/vaults'
import { Row, RecurrenceRows, taskFieldInput } from './TaskDetail'

/** The folder a path sits in ('' for the vault root). */
function folderOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ROOT_LANE
}

const STATUSES: TaskStatus[] = ['todo', 'doing', 'done']

/** The optional fields a `full` create can set before the task exists — the same
 * fields the detail editor patches, held here as a draft until submit. */
type Draft = {
  due?: string
  priority?: Priority
  tags: string[]
  reminder?: string
  recurrence?: Recurrence
}

/**
 * Create a task in any folder. A task is just a `task.<name>.md` file, and the
 * board's quick-add can only file into folders that are already lanes — so this is
 * the way to start a task in a brand-new folder (which is also how you make a new
 * lane). The folder defaults to the folder you are already in (the open note's),
 * and every existing folder is offered as a suggestion.
 *
 * Title and folder are captured here so the file is named from the real title.
 * The mode decides how much else is on screen and what happens next:
 *   - `quick` (⌘T): just title + folder + status, filed, and you stay put — pure
 *     capture, no context switch.
 *   - `full` (⌘⇧T): the whole field set (due, priority, tags, reminder, recurrence)
 *     inline, held as a draft and written in one go on create; then it opens the
 *     detail editor on the board for the markdown body.
 * Full creates with a single `tasks.create` + one `tasks.update` for the draft —
 * two writes the autosave debounce coalesces into one commit, so the filename is
 * still derived from the title rather than a placeholder. The house modal pattern
 * (fixed overlay + stop-propagation card), mounted once in the shell.
 */
export function CreateTaskDialog({
  mode,
  onClose,
}: {
  mode: CreateTaskMode
  onClose: () => void
}): React.JSX.Element {
  const snapshot = useAtomValue(snapshotAtom)
  const activeDoc = useAtomValue(activeDocAtom)
  const create = useSetAtom(createTaskAtom)
  const patch = useSetAtom(patchTaskAtom)
  const openTask = useSetAtom(openTaskAtom)

  const [title, setTitle] = useState('')
  const [folder, setFolder] = useState(() => (activeDoc ? folderOf(activeDoc.path) : ROOT_LANE))
  const [status, setStatus] = useState<TaskStatus>('todo')
  const [draft, setDraft] = useState<Draft>({ tags: [] })
  const [busy, setBusy] = useState(false)

  const folders = useMemo(
    () =>
      taskCreateFolders([
        ...snapshot.docs.map((d) => d.path),
        ...snapshot.tasks.map((t) => t.path),
        ...snapshot.files.map((f) => f.path),
        ...snapshot.broken.map((b) => b.path),
      ]),
    [snapshot],
  )

  // The merge RecurrenceRows (and the other draft rows) write through: a `null`
  // value clears a field, anything else sets it — the same shape `save` has in the
  // detail editor, so RecurrenceRows can be reused verbatim.
  const draftSave = (p: Record<string, unknown>) =>
    setDraft((d) => {
      const next = { ...d } as Record<string, unknown>
      for (const [k, v] of Object.entries(p)) {
        if (v === null || v === undefined) delete next[k]
        else next[k] = v
      }
      return next as Draft
    })

  // A Task-shaped view of the draft, so RecurrenceRows — which reads `task.due`
  // (its no-due warning) and `task.recurrence` — reuses without adaptation.
  const draftTask: Task = {
    path: '',
    title: title.trim() || 'New task',
    status,
    tags: draft.tags,
    description: '',
    due: draft.due,
    priority: draft.priority,
    reminder: draft.reminder,
    recurrence: draft.recurrence,
  }

  const submit = async () => {
    const t = title.trim()
    if (t === '' || busy) return
    setBusy(true)
    const path = await create({ title: t, status, folder: folder.trim().replace(/^\/+|\/+$/g, '') })
    if (path && mode === 'full') {
      const extra: Record<string, unknown> = {}
      if (draft.due) extra.due = draft.due
      if (draft.priority) extra.priority = draft.priority
      if (draft.tags.length) extra.tags = draft.tags
      if (draft.reminder) extra.reminder = draft.reminder
      if (draft.recurrence) extra.recurrence = draft.recurrence
      if (Object.keys(extra).length > 0) await patch(path, extra)
    }
    // `full` drops you into the detail editor on the board (for the body); `quick`
    // leaves you exactly where you were — the deliberate difference between the two.
    if (path && mode === 'full') openTask(path)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        data-create-task-dialog
        data-create-task-mode={mode}
        className="max-h-[85vh] w-96 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-950 p-4 text-sm text-neutral-200 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <p className="mb-3">{mode === 'full' ? 'New task — all fields' : 'New task'}</p>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs text-neutral-400">Title</span>
          <input
            autoFocus
            data-create-task-title
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-neutral-100 outline-none focus:border-sky-700"
            placeholder="Call the vendor"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
          />
        </label>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs text-neutral-400">Folder</span>
          <input
            data-create-task-folder
            list="create-task-folders"
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1 font-mono text-neutral-100 outline-none focus:border-sky-700"
            placeholder="(vault root)"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
          />
          <datalist id="create-task-folders">
            {folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </label>

        {mode === 'quick' ? (
          <label className="mb-4 block">
            <span className="mb-1 block text-xs text-neutral-400">Status</span>
            <select
              data-create-task-status
              className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-neutral-100"
              value={status}
              onChange={(e) => setStatus(e.target.value as TaskStatus)}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="mb-4 flex flex-col gap-2 border-t border-neutral-900 pt-3">
            <Row label="status">
              <select
                data-create-task-status
                className={taskFieldInput}
                value={status}
                onChange={(e) => setStatus(e.target.value as TaskStatus)}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Row>

            <Row label="due">
              <input
                type="date"
                data-create-task-due
                className={taskFieldInput}
                value={draft.due ?? ''}
                onChange={(e) => draftSave({ due: e.target.value === '' ? null : e.target.value })}
              />
            </Row>

            <Row label="priority">
              <select
                data-create-task-priority
                className={taskFieldInput}
                value={draft.priority ?? ''}
                onChange={(e) =>
                  draftSave({ priority: e.target.value === '' ? null : (e.target.value as Priority) })
                }
              >
                <option value="">—</option>
                <option value="high">high</option>
                <option value="medium">medium</option>
                <option value="low">low</option>
              </select>
            </Row>

            <Row label="tags">
              <input
                data-create-task-tags
                className={taskFieldInput}
                placeholder="comma, separated"
                defaultValue={draft.tags.join(', ')}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                onBlur={(e) =>
                  draftSave({
                    tags: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </Row>

            <Row label="reminder">
              <input
                data-create-task-reminder
                className={taskFieldInput}
                placeholder="1d | 2w | 2026-07-20T09:00"
                defaultValue={draft.reminder ?? ''}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                onBlur={(e) =>
                  draftSave({ reminder: e.target.value.trim() === '' ? null : e.target.value.trim() })
                }
              />
            </Row>

            <RecurrenceRows task={draftTask} save={draftSave} />
          </div>
        )}

        <div className="flex items-center justify-between">
          <span className="truncate text-xs text-neutral-500" title={laneLabel(folder.trim())}>
            → {laneLabel(folder.trim())}
          </span>
          <div className="flex gap-2">
            <button
              className="rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              data-create-task-confirm
              disabled={busy || title.trim() === ''}
              className="rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-900 hover:bg-white disabled:opacity-40"
              onClick={() => void submit()}
            >
              {mode === 'full' ? 'Create & edit →' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
