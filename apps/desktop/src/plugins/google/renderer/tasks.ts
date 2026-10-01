/**
 * The one call Google makes into the tasks plugin: a task made from a thread
 * or an event. Typed here, as only this slice, because a plugin never imports
 * another; the views offer it only while `useHasCapability('tasks.create')`
 * says the vault runs tasks.
 */
import { capClient, type UiCapability } from '@/plugin-api'

export const tasksCap = capClient<{
  'tasks.create': UiCapability<
    { title: string; folder?: string; description?: string },
    { path: string }
  >
}>('tasks')

/** The capability's name, for `useHasCapability`. */
export const TASKS_CREATE = 'tasks.create'
