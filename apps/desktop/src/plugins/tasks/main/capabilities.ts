/**
 * Tasks' capabilities: list the vault's tasks, complete one the way the board
 * does, and create one, which is how the board, other plugins and vault apps
 * add a task; set its fields, as the board and vault apps do; and the board's
 * own edits at the UI door: a move between lanes, a delete.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import { completeTask, isClosedStatus } from '@holi/shared'
import {
  isPrivateTask,
  isTaskFilePath,
  parseTaskFile,
  parseTaskPatch,
  serializeTaskFile,
  sharedTaskPath,
  snapshotTasks,
  taskFilePath,
  type TaskPatch,
  taskSlug,
} from '@holi/shared'
import { setFirstHeading, type VaultRelPath, vaultRelPath } from '@holi/shared'
import { type Task } from '@holi/shared'
import {
  absPathFor,
  cap,
  completionStatuses,
  readVaultStatuses,
  type CapabilityContext,
  CapabilityError,
  flagParam,
  knownPath,
  noParams,
  paramsObject,
  pathParams,
  readableOrNull,
  removeDocFile,
  renameNote,
  stringParam,
  withFileLock,
  writableFile,
  writablePath,
  writeAtomic,
} from '../../../main/plugin-api'
import { taskDoneOp } from './task-done'

export const TASKS_NAMESPACES = ['tasks'] as const

export interface TaskCapabilitiesDeps {
  /** Today, local, as `YYYY-MM-DD`: the frame a recurrence rolls against. */
  today(): string
}

/** A new task: its title, and where and how it starts. */
export interface CreateTaskInput {
  title: string
  /** The lane, a folder; the vault root by default. */
  folder?: string
  /** Shared with the vault, a file that syncs. Private by default: a new task
   *  is `task.<slug>.local.md`, on this machine only. */
  shared?: boolean
  /** `todo` by default. */
  status?: string
  /** Seeds the body, under the title. */
  description?: string
  /** Fields set before the task exists: due, priority, tags, assignees,
   *  reminder, recurrence. */
  extra?: Record<string, unknown>
}

/** What a create may set besides title, status, folder and body. */
const CREATE_FIELDS = [
  'start',
  'due',
  'priority',
  'estimate',
  'tags',
  'assignees',
  'reminder',
  'recurrence',
]

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

/** The task at `rel`. An unparseable task file is refused too: a field edit
 *  has nothing to merge into, and the honest place to fix bad frontmatter is
 *  the editor, on the text itself. */
async function readTask(root: string, rel: VaultRelPath): Promise<Task> {
  const text = await readFile(absPathFor(root, rel), 'utf8').catch(() => null)
  if (text === null) throw new CapabilityError('NOT_FOUND', rel)
  try {
    return parseTaskFile(text, rel)
  } catch (err) {
    throw new CapabilityError('BAD_REQUEST', `${rel}: ${(err as Error).message}`)
  }
}

/**
 * Where an app may write a task file: where it may write a note, and the
 * private twin of such a place. `isAppWritablePath` refuses every local file
 * because a local file is mostly someone's own configuration
 * (`USER.local.md`, the settings' `.local` twins); a private task is the
 * person's own task, which an app on their board may make and keep. Its
 * shared name is what the fences judge, so a task in a local folder, or in
 * any place a note could not be written, stays out of reach.
 */
function appTaskPath(path: string): VaultRelPath {
  const rel = safe(path)
  const judged = isPrivateTask(rel) ? sharedTaskPath(rel) : rel
  if (judged === null) throw new CapabilityError('FORBIDDEN', path)
  try {
    writablePath(judged)
  } catch {
    throw new CapabilityError('FORBIDDEN', path)
  }
  if (!isTaskFilePath(rel)) throw new CapabilityError('BAD_REQUEST', `${rel} is not a task file`)
  return rel
}

/**
 * `text` written to the first free `task.<slug>.md` (or, private,
 * `task.<slug>.local.md`) in `folder`.
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
  shared: boolean,
  text: string,
): Promise<VaultRelPath> {
  const slug = taskSlug(title)
  for (let n = 1; n <= 1000; n++) {
    const name = n === 1 ? slug : `${slug}-${n}`
    const rel = safe(taskFilePath(folder, name, shared))
    // The other variant's name is taken too: a shared and a private task with
    // one name could never be shared or made private, as each rename would
    // land on the other.
    const twin = safe(taskFilePath(folder, name, !shared))
    const abs =
      ctx.bundle !== null ? await writableFile(ctx, appTaskPath(rel)) : absPathFor(ctx.root, rel)
    const created = await withFileLock(abs, async () => {
      if ((await readFile(abs, 'utf8').catch(() => null)) !== null) return false
      if ((await readFile(absPathFor(ctx.root, twin), 'utf8').catch(() => null)) !== null) {
        return false
      }
      await writeAtomic(ctx.root, rel, text)
      return true
    })
    if (created) return rel
  }
  throw new CapabilityError('BAD_REQUEST', `too many tasks named like: ${title}`)
}

/** A lane move: the task, its new folder, and what rides along with it. */
export interface MoveTaskInput {
  path: string
  /** The lane, '' for the vault root. */
  folder: string
  /** A diagonal drop: the new column too. */
  status?: string
  /** Where in its new cell it was dropped. */
  order?: number
}

export const taskCapabilities = (deps: TaskCapabilitiesDeps) => {
  /**
   * A patch applied to a task. **Done is completion**, wherever it comes from
   * (a field edit, a drop into a completed column, the card's checkbox, an
   * app): on a recurring task it is the next occurrence, not the end of the
   * series (`completeTask`). Done is any status the vault's
   * `.holi/statuses.yaml` files under `completed`, and only a patch that
   * names a status completes, so re-ranking a finished card does not roll it
   * forward. The merge SPREADS rather than testing for undefined: a key
   * present-and-undefined is how `parseTaskPatch` spells "clear this field".
   */
  const patched = async (root: string, task: Task, patch: TaskPatch): Promise<Task> => {
    const next = { ...task, ...patch }
    if (patch.status === undefined) return next
    const statuses = await readVaultStatuses(root)
    if (!isClosedStatus(statuses, patch.status)) return next
    return {
      ...next,
      ...completeTask(next, deps.today(), completionStatuses(statuses, patch.status)),
    }
  }

  return {
    /**
     * A new task file in `folder`, `todo` unless a status is given. Fields set
     * before the task exists (quick add, full create) go in with the create:
     * one file, one write, through the validator a field edit uses, so nothing
     * can create a file the board would refuse to parse. `description` seeds
     * the body (the agenda's link to an event), under the title as its heading.
     * An app creates one where it may write a note (`appTaskPath`).
     *
     * **Private unless `shared`**: a new task is `task.<slug>.local.md`, on
     * this machine and no one else's board, until the person shares it.
     */
    'tasks.create': cap({
      doors: ['ui', 'app', 'cli'],
      cli: {
        args: ['title', 'folder?'],
        flags: ['shared'],
        summary: 'add a task in a folder (the vault root); private to this machine unless --shared',
      },
      writes: true,
      params: (raw): CreateTaskInput => {
        const p = paramsObject(raw)
        const extra = p.extra ?? {}
        if (typeof extra !== 'object' || extra === null || Array.isArray(extra)) {
          throw new CapabilityError('BAD_REQUEST', 'extra must be an object')
        }
        const input: CreateTaskInput = {
          title: stringParam(p, 'title'),
          shared: flagParam(p, 'shared'),
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
        const rel = await createTaskFile(
          ctx,
          input.folder ?? '',
          input.title,
          input.shared === true,
          text,
        )
        return { path: rel }
      },
      text: (r) => (isPrivateTask(r.path) ? `private: ${r.path}` : `shared: ${r.path}`),
    }),

    'tasks.list': cap({
      doors: ['app', 'cli'],
      cli: { args: [], summary: 'every task: status, title, path, and private for a private one' },
      params: noParams,
      // An app is told only the tasks it may read, as `docs.list` tells it
      // only the notes: a task's path and title are its content too.
      run: async (ctx): Promise<Task[]> => {
        const tasks = snapshotTasks(await ctx.snapshot()).items
        return ctx.bundle === null ? tasks : tasks.filter((t) => readableOrNull(t.path) !== null)
      },
      // A private task says so: it is on this machine only, and an agent
      // reporting tasks to a teammate should know which ones they cannot see.
      text: (tasks) =>
        tasks
          .map(
            (t) => `${t.status}\t${t.title}\t${t.path}${isPrivateTask(t.path) ? '\tprivate' : ''}`,
          )
          .join('\n'),
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
          ctx.bundle !== null
            ? await writableFile(ctx, appTaskPath(rel))
            : absPathFor(ctx.root, rel)
        const result = await withFileLock(abs, () => taskDoneOp(ctx.root, rel, deps.today()))
        if (!result.ok) throw new CapabilityError('BAD_REQUEST', result.error)
        return result
      },
      text: (r) => (r.status === 'done' ? `done: ${r.path}` : `next: ${r.path} due ${r.due}`),
    }),

    /**
     * A task's fields set from the board, the detail view or an app: read,
     * merge, rewrite under the file's lock, because the file is the task.
     * Validated by the module that owns the format (`parseTaskPatch`), so
     * nothing writes a task the board would refuse, and done is completion
     * (`patched`), so a recurring task rolls forward. `null` clears a field
     * that has an empty state.
     *
     * An app sets fields only, of a task file where it may write a note
     * (`writablePath`). Not the text: a task's body is a note write
     * (`docs.write`), which checks it is writing over what the app read. The
     * agent edits the frontmatter itself, and completes through
     * `holi tasks complete`.
     */
    'tasks.update': cap({
      doors: ['ui', 'app'],
      writes: true,
      params: (raw): { path: string; patch: TaskPatch } => {
        const p = paramsObject(raw)
        return { path: stringParam(p, 'path'), patch: patchOf(p.patch ?? {}) }
      },
      run: async (ctx, { path, patch }): Promise<Task> => {
        let rel: VaultRelPath
        let abs: string
        if (ctx.bundle !== null) {
          if ('description' in patch) {
            throw new CapabilityError(
              'BAD_REQUEST',
              "a task's text is not a field: write it as a note (docs.write)",
            )
          }
          rel = appTaskPath(path)
          abs = await writableFile(ctx, rel)
        } else {
          rel = safe(path)
          abs = absPathFor(ctx.root, rel)
        }
        return withFileLock(abs, async () => {
          const next = await patched(ctx.root, await readTask(ctx.root, rel), patch)
          await writeAtomic(ctx.root, rel, serializeTaskFile(next))
          return next
        })
      },
    }),

    /**
     * The horizontal drag axis: moving a card to another lane moves the
     * `task.<name>.md` file into that folder and rewrites inbound `[[wiki-links]]`.
     * A task's path is its identity, so a lane change IS a rename, reusing
     * `renameNote`'s link-rewriting pass, never a second.
     *
     * A `status` rides along for a DIAGONAL drop (lane + column in one gesture):
     * it is written in place first, so the single `renameNote` carries the final
     * content to the destination and a card is never half-dropped
     * (docs/features/tasks.md). `done` is completion (`patched`), so a
     * recurring task advances instead of persisting done. The card's place in
     * its new cell rides along like the status: a drop lands where it was
     * aimed, and is still one write.
     *
     * The basename rides along unchanged (identity slug preserved, not re-slugged
     * from `title`), and a destination that already exists is refused rather than
     * silently suffixed, which would change an existing task's identity.
     */
    'tasks.move': cap({
      doors: ['ui'],
      writes: true,
      params: (raw): MoveTaskInput => {
        const p = paramsObject(raw)
        const folder = p.folder
        if (typeof folder !== 'string')
          throw new CapabilityError('BAD_REQUEST', 'folder is required')
        const input: MoveTaskInput = { path: stringParam(p, 'path'), folder }
        const status = optionalString(p, 'status')
        if (status !== undefined) input.status = status
        // Validated by `patchOf` with the status.
        if (p.order !== undefined) input.order = p.order as number
        return input
      },
      run: async (ctx, input): Promise<Task> => {
        const from = safe(input.path)
        const basename = from.slice(from.lastIndexOf('/') + 1)
        const to = safe(input.folder ? `${input.folder}/${basename}` : basename)
        const fieldPatch = {
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.order !== undefined ? { order: input.order } : {}),
        }
        const hasPatch = Object.keys(fieldPatch).length > 0

        if (to === from && !hasPatch) return readTask(ctx.root, to)
        if (
          to !== from &&
          (await readFile(absPathFor(ctx.root, to), 'utf8').catch(() => null)) !== null
        ) {
          throw new CapabilityError('CONFLICT', `already exists: ${to}`)
        }
        if (hasPatch) {
          // Under the file's lock, as `tasks.update` writes: a field change
          // made meanwhile is read here rather than written over.
          await withFileLock(absPathFor(ctx.root, from), async () => {
            const next = await patched(
              ctx.root,
              await readTask(ctx.root, from),
              patchOf(fieldPatch),
            )
            await writeAtomic(ctx.root, from, serializeTaskFile(next))
          })
        }
        if (to !== from) await renameNote(ctx.root, from, to)
        return readTask(ctx.root, to)
      },
    }),

    /** A card's delete, and emptying Done. Git keeps them. */
    'tasks.delete': cap({
      doors: ['ui'],
      writes: true,
      params: pathParams,
      run: async (ctx, { path }) => {
        await removeDocFile(ctx.root, safe(path))
        return { ok: true as const }
      },
    }),
  }
}
