/**
 * Tasks' renderer side (docs/features/tasks.md). The board, its projects and
 * the task dialogs are the core Planning view's (`components/blocks/planning`),
 * which reaches the task files through this plugin's capabilities; the plugin
 * adds nothing to the window of its own yet.
 */
import type { RendererPlugin } from '@/plugin-api'
import { TASKS_INFO } from '../info'

export const tasksRenderer: RendererPlugin = {
  info: TASKS_INFO,
}
