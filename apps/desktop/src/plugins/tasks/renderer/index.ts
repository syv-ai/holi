/**
 * Tasks' renderer side (docs/features/tasks.md). The board, its projects and
 * the task dialogs are the core Planning view's (`features/planning`),
 * which reaches the task files through this plugin's capabilities. The plugin
 * adds New task to the files list's New menu: it asks the title first, since a
 * task's name is its title and the file is named from it.
 */
import { isBoardTaskPath } from '@holi/shared'
import { ListChecksIcon } from 'lucide-react'
import { capClient, type RendererPlugin } from '@/plugin-api'
import type { PathClaim } from '@/plugin-api/types'
import type { taskCapabilities } from '../main/capabilities'
import { TASKS_INFO } from '../info'

const tasksCap = capClient<ReturnType<typeof taskCapabilities>>('tasks')

const TASK_CLAIM: PathClaim = {
  match: isBoardTaskPath,
  create: {
    id: 'task',
    label: 'New task',
    icon: ListChecksIcon,
    placeholder: 'Task title',
    asksName: true,
    run: async ({ remote, parent, name }) =>
      (await tasksCap.create(remote, { title: name, status: 'todo', folder: parent })).path,
  },
}

export const tasksRenderer: RendererPlugin = {
  info: TASKS_INFO,
  claims: [TASK_CLAIM],
}
