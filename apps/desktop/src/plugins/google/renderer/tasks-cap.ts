/**
 * The one call Google makes into the tasks plugin: a task made from a thread
 * or an event. Typed here, as only this slice, because a plugin never imports
 * another (the params are `@holi/shared`'s `TaskCreateDraft`); the views offer
 * it only while `useHasCapability('tasks.create')` says the vault runs tasks.
 */
import type { TaskCreateDraft } from '@holi/shared'
import { capClient, type UiCapability } from '@/plugin-api'

export const tasksCreateCap = capClient<{
  'tasks.create': UiCapability<TaskCreateDraft, { path: string }>
}>('tasks')

/** The capability's name, for `useHasCapability`. */
export const TASKS_CREATE = 'tasks.create'
