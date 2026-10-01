/**
 * Tasks' capabilities: list the vault's tasks, and complete one the way the
 * board does.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { isAbsolute, relative } from 'node:path'
import type { Task } from '@holi/shared'
import { CapabilityError } from '../capabilities/error'
import { knownPath } from '../capabilities/fences'
import { noParams, pathParams } from '../capabilities/params'
import { cap } from '../capabilities/registry'
import { taskDoneOp } from './task-done'

export const TASK_NAMESPACES = ['tasks'] as const

export interface TaskCapabilitiesDeps {
  /** Today, local, as `YYYY-MM-DD`: the frame a recurrence rolls against. */
  today(): string
}

export const taskCapabilities = (deps: TaskCapabilitiesDeps) => ({
  'tasks.list': cap({
    doors: ['app', 'cli'],
    cli: { args: [], summary: 'every task: status, title and path' },
    params: noParams,
    run: async (ctx): Promise<Task[]> => (await ctx.snapshot()).tasks,
    text: (tasks) => tasks.map((t) => `${t.status}\t${t.title}\t${t.path}`).join('\n'),
  }),

  'tasks.complete': cap({
    doors: ['app', 'cli'],
    cli: {
      args: ['path'],
      summary: 'complete a task file; a recurring one rolls forward to its next occurrence',
    },
    writes: true,
    params: pathParams,
    run: async (ctx, { path }) => {
      // The agent may name the task by its absolute path, as its tools do.
      const rel = await knownPath(
        ctx,
        isAbsolute(path) ? relative(ctx.root, path) : path.replace(/^\.\//, ''),
      )
      const result = await taskDoneOp(ctx.root, rel, deps.today())
      if (!result.ok) throw new CapabilityError('BAD_REQUEST', result.error)
      return result
    },
    text: (r) => (r.status === 'done' ? `done: ${r.path}` : `next: ${r.path} due ${r.due}`),
  }),
})
