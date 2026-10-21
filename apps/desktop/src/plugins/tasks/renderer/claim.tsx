/**
 * Task files as a path claim (docs/features/tasks.md): New Task in the
 * explorer, their place out of the tree until shown, how a link to one is
 * drawn, what `@` offers of them, the narrower column their body has, their
 * frontmatter rows, and how the tree and the tabs mark them.
 */
import { EditorView } from '@codemirror/view'
import { dailyNoteFilename } from '@holi/shared'
import { snapshotTasks, TASK_FIELDS, taskClaim } from '../shared/task-file'
import { type TaskStatus } from '../shared/types'
import { atom } from 'jotai'
import { Circle, CircleCheck, CircleDot, type IconNode } from 'lucide'
import { CircleCheck as CircleCheckIcon, ListTodo } from 'lucide-react'
import type { LinkChip, PathClaim, PathMark } from '@/plugin-api'
import { TaskIcon } from './TaskIcon'
import { shortStamp, todayAtom } from '@/plugin-api'
import { snapshotTasksAtom, tasksCap, taskSuggestionsAtom, todayLinkCountAtom } from './state'
import { TASK_CONTROLS } from './fields'

/** A status's colour: the `--task-*` tokens a vault theme sets, the same
 *  ones the tree's `TaskIcon` wears. */
const STATUS_COLOUR: Record<TaskStatus, string> = {
  todo: 'var(--task-todo)',
  doing: 'var(--task-doing)',
  done: 'var(--task-done)',
}

/** The `@` menu's glyph per status, the tree's `TaskIcon` vocabulary. */
const STATUS_GLYPH: Record<TaskStatus, IconNode> = {
  todo: Circle,
  doing: CircleDot,
  done: CircleCheck,
}

/**
 * A task's body is a narrower column than a note's: as wide as its properties
 * widget (`.cm-fm`, 24rem), so a task reads as a card's back rather than a
 * page, with wider gutters either side. The lines keep their inset inside it.
 */
const taskColumn = EditorView.theme({
  '& > .cm-scroller > .cm-content': { maxWidth: 'calc(24rem + 2 * var(--editor-inset))' },
})

export const TASK_PATH_CLAIM: PathClaim = {
  match: taskClaim.match,
  normalize: taskClaim.normalize,
  // The name is the title; the plugin names the file, in any folder, whether
  // or not the tree shows task files.
  create: {
    id: 'task',
    label: 'New Task',
    icon: CircleCheckIcon,
    placeholder: 'task title',
    run: async ({ remote, parent, name }) =>
      (await tasksCap.create(remote, { title: name, status: 'todo', folder: parent })).path,
  },
  // The board owns tasks, so the tree leaves them out until asked.
  hideable: { id: 'tasks', label: 'task files', icon: ListTodo },
  editor: {
    chips: (snapshot) =>
      new Map(
        snapshotTasks(snapshot).items.map((t): [string, LinkChip] => [
          t.path,
          {
            title: t.title,
            orb: STATUS_COLOUR[t.status],
            struck: t.status === 'done',
            meta: t.due ? `${t.status} · due ${t.due}` : t.status,
          },
        ]),
      ),
    // Done tasks are left out; an ordinary `[[link]]` still reaches them.
    mentions: (snapshot) => ({
      name: 'Tasks',
      items: snapshotTasks(snapshot)
        .items.filter((t) => t.status !== 'done')
        .map((t) => ({
          path: t.path,
          label: t.title,
          glyph: STATUS_GLYPH[t.status],
          color: STATUS_COLOUR[t.status],
          ...(t.due === undefined ? {} : { meta: `due ${shortStamp(t.due)}` }),
        })),
    }),
    extensions: () => taskColumn,
  },
  frontmatter: {
    fields: TASK_FIELDS,
    controls: TASK_CONTROLS,
    alwaysOpen: true,
    suggest: taskSuggestionsAtom,
  },
}

/** Every task file's status glyph, struck when done, and today's daily note
 *  with how many open tasks link to it. */
export const taskMarksAtom = atom((get): ReadonlyMap<string, PathMark> => {
  const marks = new Map<string, PathMark>(
    get(snapshotTasksAtom).items.map((t) => [
      t.path,
      { glyph: <TaskIcon status={t.status} />, struck: t.status === 'done' },
    ]),
  )
  const linking = get(todayLinkCountAtom)
  if (linking > 0) marks.set(dailyNoteFilename(get(todayAtom)), { badge: String(linking) })
  return marks
})
