/**
 * Tasks' renderer side. The board, quick add and the task-file claim still
 * register from core while they move here.
 */
import type { RendererPlugin } from '@/plugin-api'
import { TASKS_INFO } from '../info'

export const tasksRenderer: RendererPlugin = {
  info: TASKS_INFO,
}
