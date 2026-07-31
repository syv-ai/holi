import type { Priority, Recurrence, Task, TaskStatus } from '@holi/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { useMemo, useRef, useState } from 'react'
import { FormField } from '@/composites/FormField'
import { RecurrenceRows, TaskDescriptionEditor } from '@/components/TaskDetail'
import { Button, Dialog, Input, Select } from '@/primitives'
import {
  type CreateTaskMode,
  ROOT_LANE,
  createTaskAtom,
  laneLabel,
  patchTaskAtom,
  taskCreateFolders,
} from '@/state/tasks'
import { openTaskAtom } from '@/state/view'
import { activeDocAtom, snapshotAtom } from '@/state/vaults'

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
 * Create a task in any folder — the tasks-domain content block. It knows nothing
 * about overlays or sizing: it fills a Dialog's Header/Body/Footer slots, and the
 * dialog registry summons it at `size: 'md'`. `quick` (⌘T) captures title+folder+
 * status and stays put; `full` (⌘⇧T) shows every field as a draft, writes in one
 * go, then opens the detail editor. Footer owns its own submit state (the slot,
 * not a declarative shell prop) — disabled until a title exists.
 */
export function CreateTask({
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
  // The body rides a ref, not state: the editor is mount-once, and re-rendering
  // the block on every keystroke would churn a value only read at submit.
  const bodyRef = useRef('')

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

  const draftSave = (p: Record<string, unknown>) =>
    setDraft((d) => {
      const next = { ...d } as Record<string, unknown>
      for (const [k, v] of Object.entries(p)) {
        if (v === null || v === undefined) delete next[k]
        else next[k] = v
      }
      return next as Draft
    })

  // A Task-shaped view of the draft, so RecurrenceRows reuses without adaptation.
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
      if (bodyRef.current.trim() !== '') extra.description = bodyRef.current
      if (Object.keys(extra).length > 0) await patch(path, extra)
    }
    if (path && mode === 'full') openTask(path)
    onClose()
  }

  const submitOnEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') void submit()
  }

  return (
    <>
      <Dialog.Header>{mode === 'full' ? 'New task — all fields' : 'New task'}</Dialog.Header>

      <Dialog.Body>
        <FormField label="Title">
          <Input
            autoFocus
            data-create-task-title
            placeholder="Call the vendor"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={submitOnEnter}
          />
        </FormField>

        <FormField label="Folder">
          <Input
            data-create-task-folder
            list="create-task-folders"
            className="font-mono"
            placeholder="(vault root)"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            onKeyDown={submitOnEnter}
          />
          <datalist id="create-task-folders">
            {folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </FormField>

        {mode === 'quick' ? (
          <FormField label="Status">
            <Select
              data-create-task-status
              value={status}
              onChange={(e) => setStatus(e.target.value as TaskStatus)}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </FormField>
        ) : (
          <div className="flex flex-col gap-3 border-t border-border pt-3">
            <FormField label="Status">
              <Select
                data-create-task-status
                value={status}
                onChange={(e) => setStatus(e.target.value as TaskStatus)}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </FormField>

            <FormField label="Due">
              <Input
                type="date"
                data-create-task-due
                value={draft.due ?? ''}
                onChange={(e) => draftSave({ due: e.target.value === '' ? null : e.target.value })}
              />
            </FormField>

            <FormField label="Priority">
              <Select
                data-create-task-priority
                value={draft.priority ?? ''}
                onChange={(e) =>
                  draftSave({ priority: e.target.value === '' ? null : (e.target.value as Priority) })
                }
              >
                <option value="">—</option>
                <option value="high">high</option>
                <option value="medium">medium</option>
                <option value="low">low</option>
              </Select>
            </FormField>

            <FormField label="Tags">
              <Input
                data-create-task-tags
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
            </FormField>

            <FormField label="Reminder">
              <Input
                data-create-task-reminder
                placeholder="1d | 2w | 2026-07-20T09:00"
                defaultValue={draft.reminder ?? ''}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                onBlur={(e) =>
                  draftSave({ reminder: e.target.value.trim() === '' ? null : e.target.value.trim() })
                }
              />
            </FormField>

            <RecurrenceRows task={draftTask} save={draftSave} />

            <div>
              <span className="mb-1 block text-xs text-muted-fg">description</span>
              <TaskDescriptionEditor
                notePath=""
                initial=""
                onChange={(v) => {
                  bodyRef.current = v
                }}
              />
            </div>
          </div>
        )}
      </Dialog.Body>

      <Dialog.Footer>
        <span className="mr-auto truncate text-xs text-muted-fg" title={laneLabel(folder.trim())}>
          → {laneLabel(folder.trim())}
        </span>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          data-create-task-confirm
          disabled={busy || title.trim() === ''}
          onClick={() => void submit()}
        >
          {mode === 'full' ? 'Create & edit →' : 'Create'}
        </Button>
      </Dialog.Footer>
    </>
  )
}
