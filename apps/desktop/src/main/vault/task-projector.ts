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
import type { Folder, Task, TaskFileResolvers } from '@holi/shared'
import { parseTaskFile, serializeTaskFile, taskFilePath, vaultRelPath } from '@holi/shared'
import { ProjectionStore, type ProjectedTask } from './projection-store'
import { listFiles, removeDocFile, writeAtomic } from './vault-files'
import type { TasksEvent } from './vault-manager'

export interface TaskProjectorApi {
  listTasks(): Promise<Task[]>
  listFolders(): Promise<Folder[]>
}

export interface TaskProjectorDeps {
  workRoot: string
  store: ProjectionStore
  api: TaskProjectorApi
  /** From the VaultMirror: notes render in the file as paths, not docIds. */
  notePathFor(docId: string): string | undefined
  log?: (msg: string) => void
}

export class TaskProjector {
  private readonly deps: TaskProjectorDeps
  private readonly log: (msg: string) => void
  /** taskId -> exactly what we last wrote. The inbound diff base and the echo guard. */
  private projected = new Map<string, ProjectedTask>()
  private folderPaths = new Map<string, string>()

  constructor(deps: TaskProjectorDeps) {
    this.deps = deps
    this.log = deps.log ?? ((msg) => console.log(`[tasks] ${msg}`))
  }

  async start(): Promise<void> {
    this.projected = await this.deps.store.load()
    await this.refreshFolders()

    const tasks = await this.deps.api.listTasks()
    for (const task of tasks) await this.write(task)

    await this.pruneDeleted(new Set(tasks.map((t) => t.id)))
    await this.deps.store.save(this.projected)
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

  private resolvers(): TaskFileResolvers {
    return {
      notePathFor: (docId) => this.deps.notePathFor(docId),
      folderPathFor: (folderId) => this.folderPaths.get(folderId),
    }
  }

  private async refreshFolders(): Promise<void> {
    const folders = await this.deps.api.listFolders()
    this.folderPaths = new Map(folders.map((f) => [f.id, f.path]))
  }

  /** Record -> file. A title edit re-derives the slug, so the file moves; the
   * `id` suffix keeps identity and git renders it as a rename. */
  private async write(task: Task): Promise<void> {
    const rel = taskFilePath(task)
    const text = serializeTaskFile(task, this.resolvers())
    const previous = this.projected.get(task.id)

    if (previous && previous.rel !== rel) {
      await removeDocFile(this.deps.workRoot, vaultRelPath(previous.rel))
    }
    // Unchanged bytes at an unchanged path: don't touch the file — rewriting it
    // would fire a watcher event for nothing. The disk check is not redundant:
    // the store records what we last *wrote*, not what is *there*, and a file
    // deleted while the app was closed must be re-materialized rather than
    // skipped because the store still remembers writing it.
    if (previous?.rel === rel && previous.text === text) {
      if (existsSync(join(this.deps.workRoot, rel))) return
    }

    await writeAtomic(this.deps.workRoot, vaultRelPath(rel), text)
    this.projected.set(task.id, { rel, text, version: task.version })
  }

  private async remove(taskId: string): Promise<void> {
    const previous = this.projected.get(taskId)
    if (!previous) return
    await removeDocFile(this.deps.workRoot, vaultRelPath(previous.rel))
    this.projected.delete(taskId)
  }

  /** A task file on disk whose id the server no longer knows.
   *
   * Present in the store => the server deleted it while we were away => prune.
   * Absent from the store => it was created offline => leave it; the inbound
   * path turns it into a record. Without the persisted store these two are
   * indistinguishable, which is precisely why the store exists. */
  private async pruneDeleted(live: Set<string>): Promise<void> {
    for (const [taskId, previous] of [...this.projected]) {
      if (live.has(taskId)) continue
      await removeDocFile(this.deps.workRoot, vaultRelPath(previous.rel))
      this.projected.delete(taskId)
      this.log(`pruned ${previous.rel} — deleted server-side`)
    }

    // Files we never wrote, carrying an id the server does not know: the record
    // is gone but the file survived (e.g. deleted on another machine while this
    // one had no store). Nothing else will ever reconcile them.
    const known = new Set([...this.projected.values()].map((p) => p.rel))
    for (const rel of await listFiles(this.deps.workRoot, 'tasks')) {
      if (known.has(rel) || !rel.endsWith('.md')) continue
      const id = await this.idOf(rel)
      if (id === undefined || live.has(id)) continue
      await removeDocFile(this.deps.workRoot, vaultRelPath(rel))
      this.log(`pruned ${rel} — id ${id} unknown to the server`)
    }
  }

  /** The task id in a file's frontmatter, or undefined when it has none (a
   * hand-written create) or does not parse. */
  private async idOf(rel: string): Promise<string | undefined> {
    try {
      return parseTaskFile(await readFile(join(this.deps.workRoot, rel), 'utf8')).id
    } catch {
      return undefined
    }
  }
}
