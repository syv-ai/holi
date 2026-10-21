/**
 * Task files as a path claim (docs/features/tasks.md): how a link to one is
 * drawn, what `@` offers of them, the narrower column their body has, their
 * frontmatter rows, and how the tree and the tabs mark them.
 */
import { EditorView } from '@codemirror/view'
import {
  dailyNoteFilename,
  snapshotTasks,
  TASK_FIELDS,
  taskClaim,
  type TaskStatus,
} from '@holi/shared'
import { atom } from 'jotai'
import { Circle, CircleCheck, CircleDot, type IconNode } from 'lucide'
import type { LinkChip, PathClaim, PathMark } from '@/plugin-api/types'
import { TaskIcon } from '@/composites/file-icons'
import { shortStamp } from '@/lib/date-presets'
import { todayAtom } from '@/state/clock'
import { snapshotTasksAtom, taskSuggestionsAtom, todayLinkCountAtom } from '@/state/tasks'
import { TASK_CONTROLS } from './task-fields'

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
