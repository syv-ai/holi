/**
 * Tasks' capabilities: list the vault's tasks, complete one the way the board
 * does, set its fields as the board does, and create one, which is how the
 * board, other plugins and vault apps add a task.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import {
  applyTaskPatch,
  isTaskFilePath,
  parseTaskFile,
  parseTaskPatch,
  serializeTaskFile,
  setFirstHeading,
  snapshotTasks,
  taskClaim,
  TASKS_CLAIM,
  taskFilePath,
  taskSlug,
  vaultRelPath,
  type Task,
  type TaskPatch,
  type VaultRelPath,
} from '@holi/shared'
import { CapabilityError } from '../capabilities/error'
import { knownPath, writableFile, writablePath } from '../capabilities/fences'
import { noParams, paramsObject, pathParams, stringParam } from '../capabilities/params'
import { cap, type CapabilityContext } from '../capabilities/registry'
import type { MainPlugin } from '../plugin-api'
import { archiveDone } from './hooks/archive-done'
import { taskDoneOp } from './task-done'
import { absPathFor, withFileLock, writeAtomic } from './vault-files'

export const TASK_NAMESPACES = ['tasks'] as const

/**
 * Tasks as a core part on the plugin contract, in every vault: it claims task
 * files, so the scanner parses them into `snapshot.claimed.tasks`, and runs
 * the `archive-done` commit transform.
 */
export const TASKS_PART: MainPlugin = {
  info: { id: TASKS_CLAIM, label: 'Tasks', default: true },
  claims: [taskClaim],
  transforms: [{ name: 'archive-done', run: (root, staged) => archiveDone(root, staged) }],
}

export interface TaskCapabilitiesDeps {
  /** Today, local, as `YYYY-MM-DD`: the frame a recurrence rolls against. */
  today(): string
}

/** A new task: its title, and where and how it starts. */
export interface CreateTaskInput {
  title: string
  /** The lane, a folder; the vault root by default. */
  folder?: string
  /** `todo` by default. */
  status?: string
  /** Seeds the body, under the title. */
  description?: string
  /** Fields set before the task exists: due, priority, tags, assignees,
   *  reminder, recurrence. */
  extra?: Record<string, unknown>
}

/** What a create may set besides title, status, folder and body. */
const CREATE_FIELDS = ['due', 'priority', 'tags', 'assignees', 'reminder', 'recurrence']

/** A field edit, read by the module that owns the format. */
function patchOf(raw: unknown): TaskPatch {
  try {
    return parseTaskPatch(raw)
  } catch (err) {
    throw new CapabilityError('BAD_REQUEST', (err as Error).message)
  }
}

function safe(path: string): VaultRelPath {
  try {
    return vaultRelPath(path)
  } catch (err) {
    throw new CapabilityError('BAD_REQUEST', (err as Error).message)
  }
}

/** An optional string param. */
function optionalString(p: Record<string, unknown>, key: string): string | undefined {
  const value = p[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new CapabilityError('BAD_REQUEST', `${key} must be text`)
  return value
}

/**
 * `text` written to the first free `task.<slug>.md` in `folder`.
 *
 * Two tasks may honestly share a title ("Call the vendor" twice is a normal
 * week), so a colliding slug takes a numeric suffix. Refusing would make a
 * board quick-add fail on a repeated title, which reads as a bug; overwriting
 * would silently destroy the earlier task. Each name is checked and written
 * under its file's lock, so two creates with one title take two names. An
 * app's fences come before the disk is looked at, so a refused folder learns
 * nothing about what is in it.
 */
async function createTaskFile(
  ctx: CapabilityContext,
  folder: string,
  title: string,
  text: string,
): Promise<VaultRelPath> {
  const slug = taskSlug(title)
  for (let n = 1; n <= 1000; n++) {
    const rel = safe(taskFilePath(folder, n === 1 ? slug : `${slug}-${n}`))
    const abs =
      ctx.bundle !== null ? await writableFile(ctx, writablePath(rel)) : absPathFor(ctx.root, rel)
    const created = await withFileLock(abs, async () => {
      if ((await readFile(abs, 'utf8').catch(() => null)) !== null) return false
      await writeAtomic(ctx.root, rel, text)
      return true
    })
    if (created) return rel
  }
  throw new CapabilityError('BAD_REQUEST', `too many tasks named like: ${title}`)
}

export const taskCapabilities = (deps: TaskCapabilitiesDeps) => ({
  /**
   * A new task file in `folder`, `todo` unless a status is given. Fields set
   * before the task exists (quick add, full create) go in with the create:
   * one file, one write, through the validator a field edit uses, so nothing
   * can create a file the board would refuse to parse. `description` seeds
   * the body (the agenda's link to an event), under the title as its heading.
   * An app creates one where it may write a note (`writablePath`).
   */
  'tasks.create': cap({
    doors: ['ui', 'app'],
    writes: true,
    params: (raw): CreateTaskInput => {
      const p = paramsObject(raw)
      const extra = p.extra ?? {}
      if (typeof extra !== 'object' || extra === null || Array.isArray(extra)) {
        throw new CapabilityError('BAD_REQUEST', 'extra must be an object')
      }
      const input: CreateTaskInput = {
        title: stringParam(p, 'title'),
        extra: extra as Record<string, unknown>,
      }
      const folder = optionalString(p, 'folder')
      const status = optionalString(p, 'status')
      const description = optionalString(p, 'description')
      if (folder !== undefined) input.folder = folder
      if (status !== undefined) input.status = status
      if (description !== undefined) input.description = description
      return input
    },
    run: async (ctx, input): Promise<{ path: string }> => {
      const patch = patchOf({
        ...Object.fromEntries(
          Object.entries(input.extra ?? {}).filter(([key]) => CREATE_FIELDS.includes(key)),
        ),
        status: input.status ?? 'todo',
      })
      const text = serializeTaskFile({
        ...patch,
        status: patch.status ?? 'todo',
        tags: patch.tags ?? [],
        assignees: patch.assignees ?? [],
        // The title is the body's first heading, because that is where the
        // format keeps it.
        description: setFirstHeading(input.description ?? '', input.title),
      })
      const rel = await createTaskFile(ctx, input.folder ?? '', input.title, text)
      return { path: rel }
    },
  }),

  'tasks.list': cap({
    doors: ['app', 'cli'],
    cli: { args: [], summary: 'every task: status, title and path' },
    params: noParams,
    run: async (ctx): Promise<Task[]> => snapshotTasks(await ctx.snapshot()).items,
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
      // An app writes only where it may write a note; the agent writes anywhere.
      const abs =
        ctx.bundle !== null ? await writableFile(ctx, writablePath(rel)) : absPathFor(ctx.root, rel)
      const result = await withFileLock(abs, () => taskDoneOp(ctx.root, rel, deps.today()))
      if (!result.ok) throw new CapabilityError('BAD_REQUEST', result.error)
      return result
    },
    text: (r) => (r.status === 'done' ? `done: ${r.path}` : `next: ${r.path} due ${r.due}`),
  }),

  /**
   * A task's fields set by an app, by the rule the board's field edits follow:
   * validated by the module that owns the format (`parseTaskPatch`), so an app
   * cannot write a task the board would refuse, and done is completion
   * (`applyTaskPatch`), so a recurring task rolls forward. `null` clears a
   * field that has an empty state. Not the text: a task's body is a note write
   * (`docs.write`), which checks it is writing over what the app read. The app
   * door only: the agent edits the frontmatter itself, and completes through
   * `holi tasks complete`.
   */
  'tasks.update': cap({
    doors: ['app'],
    writes: true,
    params: (raw) => {
      const p = paramsObject(raw)
      const fields = p.patch
      if (typeof fields === 'object' && fields !== null && 'description' in fields) {
        throw new CapabilityError(
          'BAD_REQUEST',
          "a task's text is not a field: write it as a note (docs.write)",
        )
      }
      return { path: stringParam(p, 'path'), patch: patchOf(fields) }
    },
    run: async (ctx, { path, patch }): Promise<Task> => {
      const rel = writablePath(path)
      if (!isTaskFilePath(rel)) {
        throw new CapabilityError('BAD_REQUEST', `${rel} is not a task file`)
      }
      const abs = await writableFile(ctx, rel)
      return withFileLock(abs, async () => {
        const text = await readFile(abs, 'utf8').catch(() => null)
        if (text === null) throw new CapabilityError('NOT_FOUND', path)
        let task: Task
        try {
          task = parseTaskFile(text, rel)
        } catch (err) {
          throw new CapabilityError('BAD_REQUEST', `${rel}: ${(err as Error).message}`)
        }
        const next = applyTaskPatch(task, patch, deps.today())
        await writeAtomic(ctx.root, rel, serializeTaskFile(next))
        return next
      })
    },
  }),
})
