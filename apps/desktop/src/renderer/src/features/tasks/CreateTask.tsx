import type { Priority, Recurrence, Task, TaskStatus } from '@holi/shared'
import { normalizeLogin, snapshotTasks } from '@holi/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { useMemo, useRef, useState } from 'react'
import { DateTimePicker, FormField, RecurrenceField } from '@/composites'
import { duePresets, reminderPresets } from '@/lib/date-presets'
import { TaskDescriptionEditor } from '@/features/tasks/TaskBodyEditor'
import {
  Button,
  Dialog,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
} from '@/primitives'
import {
  ROOT_LANE,
  createTaskAtom,
  laneLabel,
  patchTaskAtom,
  taskCreateFolders,
} from '@/state/tasks'
import { nowAtom } from '@/state/clock'
import { openTaskAtom } from '@/state/view'
import { activeDocAtom, snapshotAtom } from '@/state/vaults'

/** The folder a path sits in ('' for the vault root). */
function folderOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ROOT_LANE
}

const STATUSES: TaskStatus[] = ['todo', 'doing', 'done']

/** The optional fields a `full` create can set before the task exists, held
 * here as a draft until submit. */
type Draft = {
  due?: string
  priority?: Priority
  /** GitHub logins. */
  assignees?: string[]
  tags: string[]
  reminder?: string
  recurrence?: Recurrence
}

/**
 * Full create (⌘⇧T): every field as a draft, written in one go, then the task
 * file opens to flesh out. It fills a Dialog's Header/Body/Footer slots and
 * knows nothing about overlays or sizing. Submit is disabled until a title
 * exists. Quick capture (⌘T) is not this dialog but `QuickAdd`.
 */
export function CreateTask({ onClose }: { onClose: () => void }): React.JSX.Element {
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
  const now = useAtomValue(nowAtom)
  // The body rides a ref, not state: the editor is mount-once, and re-rendering
  // the block on every keystroke would churn a value only read at submit.
  const bodyRef = useRef('')

  const folders = useMemo(
    () =>
      taskCreateFolders([
        ...snapshot.docs.map((d) => d.path),
        ...snapshotTasks(snapshot).items.map((t) => t.path),
        ...snapshot.files.map((f) => f.path),
        ...snapshotTasks(snapshot).broken.map((b) => b.path),
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
    // The body goes in with the create, which puts the title heading above it.
    // A `description` patch afterwards would replace the whole body, heading too.
    const body = bodyRef.current.trim()
    // Every field goes in with the create: one file, one write.
    const path = await create({
      title: t,
      status,
      folder: folder.trim().replace(/^\/+|\/+$/g, ''),
      ...(body !== '' ? { description: body } : {}),
      extra: {
        ...(draft.due ? { due: draft.due } : {}),
        ...(draft.priority ? { priority: draft.priority } : {}),
        ...(draft.assignees?.length ? { assignees: draft.assignees } : {}),
        ...(draft.tags.length ? { tags: draft.tags } : {}),
        ...(draft.reminder ? { reminder: draft.reminder } : {}),
        ...(draft.recurrence ? { recurrence: draft.recurrence } : {}),
      },
    })
    if (path) openTask(path)
    onClose()
  }

  const submitOnEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') void submit()
  }

  return (
    <>
      <Dialog.Header>New task</Dialog.Header>

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

        <div className="flex flex-col gap-3 border-t border-divider pt-3">
          <FormField label="Status">
            <Select value={status} onValueChange={(v) => setStatus(v as TaskStatus)}>
              <SelectTrigger className="w-full" data-create-task-status>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          <FormField label="Due">
            <DateTimePicker
              value={draft.due ?? null}
              placeholder="no due date"
              data-testid="create-task-due"
              presets={duePresets(now)}
              onChange={(next) => draftSave({ due: next })}
            />
          </FormField>

          <FormField label="Priority">
            {/* Radix Select forbids an empty-string value, so 'none' is the
                  sentinel for "no priority" (mapped back to undefined on save). */}
            <Select
              value={draft.priority ?? 'none'}
              onValueChange={(v) => draftSave({ priority: v === 'none' ? null : (v as Priority) })}
            >
              <SelectTrigger className="w-full" data-create-task-priority>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">—</SelectItem>
                <SelectItem value="high">high</SelectItem>
                <SelectItem value="medium">medium</SelectItem>
                <SelectItem value="low">low</SelectItem>
              </SelectContent>
            </Select>
          </FormField>

          <FormField label="Assignees">
            <Input
              data-create-task-assignees
              placeholder="GitHub usernames, comma separated"
              defaultValue={(draft.assignees ?? []).map((a) => `@${a}`).join(', ')}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              onBlur={(e) =>
                draftSave({
                  assignees: e.target.value
                    .split(/[,\s]+/)
                    .map(normalizeLogin)
                    .filter(Boolean),
                })
              }
            />
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
            {/* The shortcuts follow the draft's own due date, so setting Due
                  above changes what "1 day before" means down here. */}
            <DateTimePicker
              value={draft.reminder ?? null}
              placeholder="no reminder"
              data-testid="create-task-reminder"
              presets={reminderPresets(draft.due, now)}
              onChange={(next) => draftSave({ reminder: next })}
            />
          </FormField>

          <FormField label="Repeats">
            <RecurrenceField
              value={draft.recurrence}
              data-testid="create-task-recurrence"
              onChange={(next) => draftSave({ recurrence: next })}
            />
          </FormField>

          <div>
            <span className="mb-1 block text-xs text-muted-foreground">description</span>
            <TaskDescriptionEditor
              notePath=""
              initial=""
              onChange={(v) => {
                bodyRef.current = v
              }}
            />
          </div>
        </div>
      </Dialog.Body>

      <Dialog.Footer>
        <Tooltip content={laneLabel(folder.trim())}>
          <span className="mr-auto truncate text-xs text-muted-foreground">
            → {laneLabel(folder.trim())}
          </span>
        </Tooltip>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          data-create-task-confirm
          disabled={busy || title.trim() === ''}
          onClick={() => void submit()}
        >
          Create & edit →
        </Button>
      </Dialog.Footer>
    </>
  )
}
