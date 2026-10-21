/**
 * Tasks' renderer side (docs/features/tasks.md): the board, homeable, with
 * its place in the nav menu and its count; quick add (⌘T) over the panes and
 * the full create (⌘⇧T) as a dialog; the task-file claim; and the marks task
 * files carry in the tree and the tabs.
 */
import { createElement } from 'react'
import { SquareKanban } from 'lucide-react'
import { openDialogAtom, type RendererPlugin } from '@/plugin-api'
import { TASKS_INFO } from '../info'
import { BoardView } from './BoardView'
import { TASK_PATH_CLAIM, taskMarksAtom } from './claim'
import { CreateTask } from './CreateTask'
import { QuickAddHost } from './QuickAddHost'
import { boardBadgeAtom, openQuickAddAtom } from './state'

export const tasksRenderer: RendererPlugin = {
  info: TASKS_INFO,
  surfaces: [
    { kind: 'board', label: 'Board', icon: SquareKanban, render: BoardView, homeable: true },
  ],
  rail: [{ surface: 'board', order: 30, badge: boardBadgeAtom }],
  claims: [TASK_PATH_CLAIM],
  overlays: [QuickAddHost],
  pathMarks: taskMarksAtom,
  // Create a task in any folder, including one that is not yet a lane. ⌘T is
  // quick add, the card it will make, in the board's dock or centred; ⌘⇧T is
  // the full dialog, which opens the task to fill in the rest.
  commands: [
    {
      id: 'task.new',
      label: 'New task',
      hotkey: '⌘T',
      firstKey: 2,
      run: (_get, set) => set(openQuickAddAtom),
    },
    {
      id: 'task.new.full',
      label: 'New task with details',
      hotkey: '⌘⇧T',
      run: (_get, set) =>
        set(openDialogAtom, {
          id: 'plugin',
          size: 'md',
          render: (close) => createElement(CreateTask, { onClose: close }),
        }),
    },
  ],
}
