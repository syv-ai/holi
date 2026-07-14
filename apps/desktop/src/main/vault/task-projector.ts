/** The task file projection (prd/tasks.md §Task file projection).
 *
 * Tasks are authoritative **server records**. This projects each one into the
 * working copy as `tasks/<slug>-<id>.md` so the agent (and the user) can work
 * tasks as ordinary files.
 *
 * A sibling of VaultMirror, deliberately NOT a part of it: task files are not
 * CRDT docs. They carry no base, no turn, no merge and no snapshot — the mirror
 * excludes them from the doc machinery entirely (`isTaskFilePath`), and they are
 * fed from `tasks.list` + the SSE `tasks` channel instead of the relay.
 *
 * Direction of truth:
 *   record -> file   a full rewrite, on any change, whoever caused it
 *   file   -> record a per-field patch (see the inbound half), version-guarded
 *
 * Nothing here ever *queries* the files. The board, the agenda, reminders and
 * task_list all read Postgres; parsing happens only on an inbound write.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  Folder,
  Priority,
  Recurrence,
  RelatedRef,
  Task,
  TaskFileFields,
  TaskFileResolvers,
  TaskStatus,
  VaultRelPath,
} from '@holi/shared'
import {
  TaskFileError,
  areaFromFile,
  parseTaskFile,
  relatedFromFile,
  serializeTaskFile,
  taskFilePath,
  vaultRelPath,
} from '@holi/shared'
import { ProjectionStore, type ProjectedTask } from './projection-store'
import { listFiles, removeDocFile, writeAtomic } from './vault-files'
import type { TasksEvent } from './vault-manager'

/** Record-form fields. `null` clears; absent means "not mentioned". */
export interface TaskWrite {
  title?: string
  status?: TaskStatus
  area?: string | null
  due?: string | null
  priority?: Priority | null
  tags?: string[]
  reminder?: string | null
  recurrence?: Recurrence | null
  related?: RelatedRef[]
  description?: string | null
}

export interface TaskProjectorApi {
  listTasks(): Promise<Task[]>
  listFolders(): Promise<Folder[]>
  getTask(taskId: string): Promise<Task | null>
  createTask(input: TaskWrite & { title: string }): Promise<Task>
  /** Throws CONFLICT when `version` is stale. */
  updateTask(taskId: string, patch: TaskWrite, version: number): Promise<Task>
  completeTask(taskId: string, version: number): Promise<Task>
  deleteTask(taskId: string, version: number): Promise<void>
}

export interface TaskProjectorDeps {
  workRoot: string
  store: ProjectionStore
  api: TaskProjectorApi
  /** From the VaultMirror: notes render in the file as paths, not docIds. */
  notePathFor(docId: string): string | undefined
  docIdForPath(path: string): string | undefined
  log?: (msg: string) => void
}

/** The fields an inbound write can carry, in file form. */
const DIFFABLE = [
  'title',
  'status',
  'area',
  'due',
  'priority',
  'tags',
  'reminder',
  'recurrence',
  'related',
] as const

function isConflict(err: unknown): boolean {
  const e = err as { data?: { code?: string }; code?: string } | null
  return e?.data?.code === 'CONFLICT' || e?.code === 'CONFLICT'
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

export class TaskProjector {
  private readonly deps: TaskProjectorDeps
  private readonly log: (msg: string) => void
  /** taskId -> exactly what we last wrote. The inbound diff base and the echo guard. */
  private projected = new Map<string, ProjectedTask>()
  private folderPaths = new Map<string, string>() // folderId -> path
  private folderIds = new Map<string, string>() // path -> folderId

  constructor(deps: TaskProjectorDeps) {
    this.deps = deps
    this.log = deps.log ?? ((msg) => console.log(`[tasks] ${msg}`))
  }

  /**
   * Reconcile disk against the record. Three cases, all decidable *because* the
   * projection is persisted — with an in-memory-only store they collapse into
   * one indistinguishable mess:
   *
   *   disk == store            nothing happened while we were away
   *   disk != store            an edit landed while the app was closed -> patch
   *                            it through the inbound path (a real per-field
   *                            diff), do NOT overwrite it with server truth
   *   id unknown to server     in the store => deleted server-side => prune
   *                            not in the store => created offline => create
   */
  async start(): Promise<void> {
    this.projected = await this.deps.store.load()
    await this.refreshFolders()

    const tasks = await this.deps.api.listTasks()
    for (const task of tasks) {
      const previous = this.projected.get(task.id)
      const onDisk = previous
        ? await readFile(join(this.deps.workRoot, previous.rel), 'utf8').catch(() => null)
        : null

      if (previous && onDisk !== null && onDisk !== previous.text) {
        // Edited while we were closed. Overwriting from truth here would discard
        // it; a whole-record overwrite would destroy a teammate's concurrent
        // change. Diff it against what we last wrote — that is the whole point.
        await this.onTaskFileEvent('change', vaultRelPath(previous.rel))
        continue
      }
      await this.write(task)
    }

    await this.pruneDeleted(new Set(tasks.map((t) => t.id)))
    await this.deps.store.save(this.projected)
    await this.adoptUnknownFiles()
  }

  /** Task files we never wrote. An id-less one is an offline create; one whose
   * id the server does not know has lost its record and is rewritten away. */
  private async adoptUnknownFiles(): Promise<void> {
    const known = new Set([...this.projected.values()].map((p) => p.rel))
    for (const rel of await listFiles(this.deps.workRoot, 'tasks')) {
      if (known.has(rel) || !rel.endsWith('.md')) continue
      await this.onTaskFileEvent('add', vaultRelPath(rel))
    }
  }

  /** The server moved a task — a board drag, a teammate, a recurrence roll, a
   * reminder fire. The file changes under whoever is looking at it, by design. */
  async applyTasksEvent(event: TasksEvent): Promise<void> {
    if (event.type === 'upserted') await this.write(event.task)
    else await this.remove(event.taskId)
    await this.deps.store.save(this.projected)
  }

  /** What we last wrote for a task, or undefined. The inbound half diffs against
   * this, never against the current record: diffing against the record would
   * read a teammate's concurrent change as a field this writer changed back. */
  lastProjection(taskId: string): ProjectedTask | undefined {
    return this.projected.get(taskId)
  }

  // ---------------------------------------------------------------- inbound

  /** A task file changed on disk (the agent, the user, an editor). The mirror
   * routes these here: task files are records, not docs.
   *
   * Every path ends in either a tRPC mutation or a rewrite-from-truth. There is
   * no third outcome and no conflict UI. */
  async onTaskFileEvent(kind: 'add' | 'change' | 'unlink', rel: VaultRelPath): Promise<void> {
    try {
      if (kind === 'unlink') await this.inboundDelete(rel)
      else await this.inboundWrite(rel)
    } catch (err) {
      this.log(`inbound ${kind} failed for ${rel}: ${err}`)
    }
  }

  /** `rm tasks/….md` deletes the task — the note symmetry the mirror already has
   * (agent rm -> doc delete), applied to records. */
  private async inboundDelete(rel: VaultRelPath): Promise<void> {
    const entry = this.byRel(rel)
    if (!entry) return // our own rename, or a file we never wrote
    // The file coming back means this was a rewrite, not a delete. (chokidar can
    // also coalesce delete-then-recreate into a single `change`, which lands on
    // the write path instead — that is fine, and a guard keyed on the unlink
    // event alone would be unimplementable.)
    if (existsSync(join(this.deps.workRoot, rel))) return

    const [taskId, previous] = entry
    try {
      await this.deps.api.deleteTask(taskId, previous.version)
    } catch (err) {
      if (!isConflict(err)) throw err
      // A stale delete loses exactly as a stale field write does: the record moved
      // on under the `rm` (a reminder fired, a teammate edited) and the writer was
      // acting on a file that no longer described it. The record is still alive, so
      // its file has to come back — dropping the projection and leaving disk empty
      // would strand a live task with no file and nothing to restore it.
      await this.rewriteFromTruth(rel, taskId, 'stale version — delete rejected')
      return
    }
    // Only once the record is actually gone. Forgetting the task before the
    // mutation lands means a rejected delete has nothing left to rewrite from.
    this.projected.delete(taskId)
    await this.deps.store.save(this.projected)
    this.log(`deleted task ${taskId} — ${rel} removed`)
  }

  private async inboundWrite(rel: VaultRelPath): Promise<void> {
    const text = await readFile(join(this.deps.workRoot, rel), 'utf8').catch(() => null)
    if (text === null) return // vanished again

    const entry = this.byRel(rel)
    if (entry && entry[1].text === text) return // our own write, echoed by the watcher

    let parsed: ReturnType<typeof parseTaskFile>
    try {
      parsed = parseTaskFile(text)
    } catch (err) {
      // Unparseable writes lose. The model *will* write bad frontmatter, so the
      // projection is resilient by construction rather than by prompting.
      if (!entry) {
        // ...but there is no record behind a file we never projected, and
        // "rewrite from truth" with no truth means *deleting the file*. That would
        // destroy the agent's brand-new task over a stray colon in the title — a
        // silent deletion of work, with nothing left to read and correct. Leave it
        // on disk; the writer's next save comes straight back through here.
        this.log(`unparseable ${rel} has no record behind it — left alone: ${(err as Error).message}`)
        return
      }
      await this.rewriteFromTruth(rel, entry[0], `unparseable: ${(err as Error).message}`)
      return
    }

    if (parsed.id === undefined) {
      await this.inboundCreate(rel, parsed.fields, parsed.description)
      return
    }
    await this.inboundPatch(rel, parsed.id, parsed.version, parsed.fields, parsed.description)
  }

  /** A well-formed file with no `id` creates a task, then moves to its canonical
   * path — the agent wrote `tasks/whatever.md`, but the record's id names it. */
  private async inboundCreate(
    rel: VaultRelPath,
    fields: TaskFileFields,
    description: string,
  ): Promise<void> {
    await this.refreshFoldersIfUnknown(fields.area)
    let write: TaskWrite
    try {
      write = this.toRecord(fields, description)
    } catch (err) {
      this.log(`discarded ${rel}: ${(err as Error).message}`)
      return // nothing to rewrite from — there is no record yet
    }

    const created = await this.deps.api.createTask({ ...write, title: fields.title! })
    const canonical = taskFilePath(created)
    if (canonical !== rel) await removeDocFile(this.deps.workRoot, rel)
    await this.write(created)
    await this.deps.store.save(this.projected)
    this.log(`created task ${created.id} from ${rel}`)
  }

  private async inboundPatch(
    rel: VaultRelPath,
    taskId: string,
    version: number | undefined,
    fields: TaskFileFields,
    description: string,
  ): Promise<void> {
    const previous = this.projected.get(taskId)
    if (!previous || version === undefined) {
      // We never wrote this file, or it carries no concurrency token: we cannot
      // tell which fields the writer touched, and a whole-record overwrite would
      // destroy anyone else's concurrent change. Truth wins.
      await this.rewriteFromTruth(rel, taskId, 'no known projection to diff against')
      return
    }

    await this.refreshFoldersIfUnknown(fields.area)

    const before = parseTaskFile(previous.text)
    const patch: TaskWrite = {}
    let changed = false

    for (const key of DIFFABLE) {
      if (same(fields[key], before.fields[key])) continue
      changed = true
      try {
        this.assign(patch, key, fields[key])
      } catch (err) {
        // e.g. a related[] note path or an area folder that resolves to nothing
        await this.rewriteFromTruth(rel, taskId, (err as Error).message)
        return
      }
    }
    if (description !== before.description) {
      changed = true
      patch.description = description === '' ? null : description
    }

    // `status: done` cannot express "roll the recurrence" vs "end the series" —
    // that ambiguity is exactly why task_set survives as an op. From a file we
    // take the only safe reading: complete it, and let the server roll.
    const completing = patch.status === 'done'
    if (completing) delete patch.status

    if (Object.keys(patch).length === 0 && !completing) {
      // Nothing to send. Either the bytes moved but nothing meaningful did (a
      // cosmetic reformat), or the writer's only change was one the record cannot
      // express: deleting `status:`, which is NOT NULL on the record just like
      // `title`, so `assign` has no null form to send for it.
      //
      // Both end the same way — canonical truth goes back on disk. Returning here
      // instead would be the one outcome this projection does not permit: a write
      // that is neither applied nor undone, leaving the file describing a record
      // that does not exist and nothing that would ever put it right.
      await this.rewriteFromTruth(rel, taskId, changed ? 'no expressible change' : 'no effective change')
      return
    }

    try {
      let current =
        Object.keys(patch).length > 0
          ? await this.deps.api.updateTask(taskId, patch, version)
          : null
      if (completing) {
        current = await this.deps.api.completeTask(taskId, current?.version ?? version)
      }
      if (current) {
        await this.write(current)
        await this.deps.store.save(this.projected)
      }
    } catch (err) {
      if (!isConflict(err)) throw err
      // Stale writes lose: the record moved on under the writer. No conflict
      // dialog, nothing to resolve — the file is rewritten from truth and the
      // agent sees the corrected version on its next Read.
      await this.rewriteFromTruth(rel, taskId, 'stale version')
    }
  }

  /** The file loses. Put the record's truth back on disk — never leave the file
   * in the writer's rejected state, which would silently diverge disk from
   * truth. */
  private async rewriteFromTruth(
    rel: VaultRelPath,
    taskId: string | undefined,
    why: string,
  ): Promise<void> {
    this.log(`discarded write to ${rel} (${why})`)
    const task = taskId ? await this.deps.api.getTask(taskId) : null
    if (!task) {
      // The record is gone: so is the file's reason to exist.
      await removeDocFile(this.deps.workRoot, rel)
      if (taskId) this.projected.delete(taskId)
    } else {
      const canonical = taskFilePath(task)
      if (canonical !== rel) await removeDocFile(this.deps.workRoot, rel)
      // force the write even if the store thinks the bytes are current
      this.projected.delete(task.id)
      await this.write(task)
    }
    await this.deps.store.save(this.projected)
  }

  /** File form -> record form. Throws TaskFileError on an unresolvable folder
   * path or note path, which rejects the whole write. */
  private toRecord(fields: TaskFileFields, description: string): TaskWrite {
    const write: TaskWrite = {}
    for (const key of DIFFABLE) {
      if (!(key in fields)) continue
      this.assign(write, key, fields[key])
    }
    if (description !== '') write.description = description
    return write
  }

  private assign<K extends (typeof DIFFABLE)[number]>(
    patch: TaskWrite,
    key: K,
    value: TaskFileFields[K],
  ): void {
    if (value === undefined) {
      // The key was deleted from the frontmatter. `undefined` would read as "not
      // mentioned" and the field would silently survive its own deletion, so
      // clearing has to be explicit.
      if (key === 'tags') patch.tags = []
      else if (key === 'related') patch.related = []
      else if (key !== 'title' && key !== 'status') (patch as Record<string, null>)[key] = null
      return
    }
    if (key === 'area') {
      patch.area = areaFromFile(value as string, (path) => this.folderIds.get(path))
    } else if (key === 'related') {
      patch.related = relatedFromFile(value as never, (path) => this.deps.docIdForPath(path))
    } else {
      ;(patch as Record<string, unknown>)[key] = value
    }
  }

  private byRel(rel: string): [string, ProjectedTask] | undefined {
    for (const entry of this.projected) if (entry[1].rel === rel) return entry
    return undefined
  }

  private resolvers(): TaskFileResolvers {
    return {
      notePathFor: (docId) => this.deps.notePathFor(docId),
      folderPathFor: (folderId) => this.folderPaths.get(folderId),
    }
  }

  private async refreshFolders(): Promise<void> {
    const folders = await this.deps.api.listFolders()
    this.folderPaths = new Map(folders.map((f) => [f.id, f.path]))
    this.folderIds = new Map(folders.map((f) => [f.path, f.id]))
  }

  /** The folder map is a snapshot, and folders move under it: the server creates
   * one as a side effect of a note's path (paths.ts) and the rename machinery
   * repaths them, neither of which emits an event we subscribe to. So an `area`
   * we cannot resolve is just as likely to be *new* as bogus.
   *
   * Refresh before letting `areaFromFile` reject it. Without this, the agent makes
   * a note under a new folder, sets `area:` to that folder, and the write is thrown
   * out as unresolvable — along with every other field it edited in the same pass —
   * and keeps being thrown out for the rest of the session, identically on retry.
   * The "reject the whole file" rule is only defensible while it fires on genuinely
   * bogus paths. */
  private async refreshFoldersIfUnknown(area: string | undefined): Promise<void> {
    if (area === undefined) return
    // known as a path, or as the raw id a deleted folder serializes to
    if (this.folderIds.has(area) || this.folderPaths.has(area)) return
    await this.refreshFolders()
  }

  /** Record -> file. A title edit re-derives the slug, so the file moves; the
   * `id` suffix keeps identity and git renders it as a rename. */
  private async write(task: Task): Promise<void> {
    const rel = taskFilePath(task)
    const text = serializeTaskFile(task, this.resolvers())
    const previous = this.projected.get(task.id)

    // Unchanged bytes at an unchanged path: don't touch the file — rewriting it
    // would fire a watcher event for nothing. The disk check is not redundant:
    // the store records what we last *wrote*, not what is *there*, and a file
    // deleted while the app was closed must be re-materialized rather than
    // skipped because the store still remembers writing it.
    if (previous?.rel === rel && previous.text === text) {
      if (existsSync(join(this.deps.workRoot, rel))) return
    }

    // Update the projection BEFORE touching disk. Our own fs operations come
    // back through the watcher, and this ordering is what makes them safe with
    // no timers: the new text is already the echo guard's reference, and a
    // rename's unlink of the old path can no longer resolve to a live task —
    // otherwise the projector would read its own rename as an agent `rm` and
    // delete the record.
    this.projected.set(task.id, { rel, text, version: task.version })

    if (previous && previous.rel !== rel) {
      await removeDocFile(this.deps.workRoot, vaultRelPath(previous.rel))
    }
    await writeAtomic(this.deps.workRoot, vaultRelPath(rel), text)
  }

  private async remove(taskId: string): Promise<void> {
    const previous = this.projected.get(taskId)
    if (!previous) return
    this.projected.delete(taskId) // before disk, so our own unlink is inert
    await removeDocFile(this.deps.workRoot, vaultRelPath(previous.rel))
  }

  /** A task we projected that the server no longer has: it was deleted while we
   * were away. Prune the file.
   *
   * Absent from the store instead? Then it was created offline, and
   * adoptUnknownFiles turns it into a record. Without the persisted store these
   * two are indistinguishable — which is precisely why the store exists. */
  private async pruneDeleted(live: Set<string>): Promise<void> {
    for (const [taskId, previous] of [...this.projected]) {
      if (live.has(taskId)) continue
      this.projected.delete(taskId)
      await removeDocFile(this.deps.workRoot, vaultRelPath(previous.rel))
      this.log(`pruned ${previous.rel} — deleted server-side`)
    }
  }
}
