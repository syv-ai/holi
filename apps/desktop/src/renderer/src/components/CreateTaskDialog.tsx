import type { TaskStatus } from '@holi/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { useMemo, useState } from 'react'
import { ROOT_LANE, createTaskAtom, laneLabel, taskCreateFolders } from '../state/tasks'
import { openTaskAtom } from '../state/view'
import { activeDocAtom, snapshotAtom } from '../state/vaults'

/** The folder a path sits in ('' for the vault root). */
function folderOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ROOT_LANE
}

const STATUSES: TaskStatus[] = ['todo', 'doing', 'done']

/**
 * Create a task in any folder (⌘T). A task is just a `task.<name>.md` file, and
 * the board's quick-add can only file into folders that are already lanes — so
 * this is the way to start a task in a brand-new folder (which is also how you
 * make a new lane). The folder defaults to the folder you are already in (the
 * open note's), and every existing folder is offered as a suggestion.
 *
 * On create it jumps to the board with the new task selected: a task filed into a
 * folder is otherwise invisible until you find its lane, and a create that shows
 * nothing reads as a create that failed. The house modal pattern (fixed overlay +
 * stop-propagation card), mounted once in the shell and shown by an atom.
 */
export function CreateTaskDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const snapshot = useAtomValue(snapshotAtom)
  const activeDoc = useAtomValue(activeDocAtom)
  const create = useSetAtom(createTaskAtom)
  const openTask = useSetAtom(openTaskAtom)

  const [title, setTitle] = useState('')
  const [folder, setFolder] = useState(() => (activeDoc ? folderOf(activeDoc.path) : ROOT_LANE))
  const [status, setStatus] = useState<TaskStatus>('todo')
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

  const submit = async () => {
    const t = title.trim()
    if (t === '' || busy) return
    setBusy(true)
    // The route derives `task.<slug>.md`; a stray leading/trailing slash on a
    // hand-typed folder would otherwise become an empty path segment.
    const path = await create({ title: t, status, folder: folder.trim().replace(/^\/+|\/+$/g, '') })
    if (path) openTask(path) // jump to the board with it selected — visible feedback
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        data-create-task-dialog
        className="w-96 rounded-lg border border-neutral-800 bg-neutral-950 p-4 text-sm text-neutral-200 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <p className="mb-3">New task</p>

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
              Create
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
