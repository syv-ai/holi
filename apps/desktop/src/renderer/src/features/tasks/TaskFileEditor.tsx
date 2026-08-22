/**
 * A task file, opened in the editor pane, shown as a task — not raw frontmatter.
 *
 * The structured data lives in the file's YAML frontmatter (that is the storage
 * decision, unchanged); this only *renders* it well. Opening `task.*.md` used to
 * drop you into the generic markdown editor, where the fields were a squished
 * frontmatter block you had to parse by eye. Here the fields are real controls in
 * a header, and the markdown body sits below in the same editor the note gets —
 * "a document with a proper task header".
 *
 * The same field controls as the board's detail sidebar (`TaskScalarFields`,
 * `RecurrenceRows`, `TaskDescriptionEditor`), so both surfaces edit a task
 * identically; every write is a `tasks.update` patch, last-write-wins with the
 * file. A task whose frontmatter will not parse has no fields to render, so it
 * falls back to the raw editor — the honest place to fix bad YAML by hand.
 */
import type { Task } from '@holi/shared'
import type { ConflictResolvers } from '@/lib/editor-reload'
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef, useState } from 'react'
import { Button, Input, Tooltip } from '@/primitives'
import {
  completeTaskAtom,
  deleteTaskAtom,
  laneLabel,
  laneOf,
  patchTaskAtom,
  tasksAtom,
} from '@/state/tasks'
import { EditorPane, GoogleLinkChips } from '@/composites'
import {
  RecurrenceRows,
  TaskDescriptionEditor,
  TaskScalarFields,
  TaskTagsRow,
} from './TaskDetail'

export function TaskFileEditor({
  path,
  onOpenNote,
  onEdit,
  onConflict,
}: {
  path: string
  onOpenNote: (path: string) => void
  onEdit?: () => void
  onConflict: (path: string, resolve: ConflictResolvers) => void
}): React.JSX.Element {
  const task = useAtomValue(tasksAtom).get(path)

  // Unparseable (or not-yet-scanned) → the raw editor, so the YAML can be fixed by
  // hand. Keyed by path so a switch remounts with the right file.
  if (!task) {
    return (
      <EditorPane
        key={path}
        path={path}
        onOpenNote={onOpenNote}
        onEdit={onEdit}
        onConflict={onConflict}
      />
    )
  }
  return <TaskFileBody key={task.path} task={task} onEdit={onEdit} />
}

function TaskFileBody({ task, onEdit }: { task: Task; onEdit?: () => void }): React.JSX.Element {
  const patch = useSetAtom(patchTaskAtom)
  const complete = useSetAtom(completeTaskAtom)
  const del = useSetAtom(deleteTaskAtom)

  const [title, setTitle] = useState(task.title)
  useEffect(() => setTitle(task.title), [task.path, task.title])

  // First edit promotes a preview tab to pinned, exactly as note editing does, so
  // opening another file never discards a task you started changing.
  const edited = useRef(false)
  const markEdited = () => {
    if (edited.current) return
    edited.current = true
    onEdit?.()
  }

  const save = (p: Record<string, unknown>) => {
    markEdited()
    void patch(task.path, p)
  }
  const doComplete = (path: string) => {
    markEdited()
    void complete(path)
  }

  // Debounce the body: a keystroke-per-mutation would rewrite (and later commit)
  // the file on every character.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onDescription = (v: string) => {
    markEdited()
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void patch(task.path, { description: v }), 600)
  }
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

  return (
    <div data-task-file={task.path} className="flex flex-1 flex-col overflow-y-auto p-4">
      {/* Borderless title that shows its edge only on hover/focus (overrides on Input). */}
      <Input
        value={title}
        data-task-file-title
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => title.trim() && title !== task.title && save({ title: title.trim() })}
        className="mb-1 h-auto border-transparent bg-transparent px-1 py-0.5 text-lg font-semibold shadow-none hover:border-input focus-visible:border-ring focus-visible:ring-0"
      />

      {/* Path/lane, read-only — moving the file rewrites inbound links, which is the
          file tree's rename (or a board lane drag), not a text field here. */}
      <Tooltip content={task.path}>
        <p className="mb-3 px-1 font-mono text-[10px] text-muted-foreground">
          {laneLabel(laneOf(task))}
        </p>
      </Tooltip>

      {/* Linked mail/calendar (D67) — **detected in the body, never stored.**
          The link itself is ordinary markdown in the description below; this row
          is a rendering of it, exactly as `overdue`/`pN` are renderings of `due`
          and `priority`. Deleting the link in the body removes the chip; nothing
          writes back. */}
      <GoogleLinkChips body={task.description} />

      {/* The properties, constrained so they read as a header band, not a field that
          stretches the whole pane. */}
      <div className="flex max-w-md flex-col gap-2 rounded-md border border-border bg-muted/40 p-3">
        <TaskScalarFields task={task} save={save} complete={doComplete} />
        <RecurrenceRows task={task} save={save} />
        <TaskTagsRow task={task} save={save} />
      </div>

      <Button
        variant="ghost"
        size="sm"
        onClick={() => void del(task.path)}
        className="mt-2 self-start text-destructive hover:bg-destructive/10 hover:text-destructive"
      >
        delete task
      </Button>

      <div className="mt-3 flex flex-1 flex-col">
        <span className="mb-1 px-1 text-xs text-muted-foreground">description</span>
        <TaskDescriptionEditor
          notePath={task.path}
          initial={task.description}
          onChange={onDescription}
          hostClassName="flex-1 min-h-[16rem] overflow-auto rounded-md border border-input bg-transparent text-sm focus-within:border-ring"
        />
      </div>
    </div>
  )
}
