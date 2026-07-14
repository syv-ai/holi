/**
 * The `tasks/**.md` branch of git ingestion (D34).
 *
 * A remote Claude Code session has a clone and nothing else — no MCP, no ops. Tasks
 * reach it as files, so its edits reach us as commits, and this is where a commit
 * becomes a record.
 *
 * **The diff base is the commit's own base blob**, which is the whole reason this is
 * simpler than the desktop's half. The desktop needs a persisted ProjectionStore to
 * answer "what did the writer edit against?"; git answers it for free. So the patch is
 * exact — a field the commit never touched is never sent, and a teammate's concurrent
 * change to it survives — and there is no version token, because there is nothing for
 * one to protect against.
 *
 * Everything here goes through `tasks/mutations.ts`. Writing the table directly would
 * skip recomputeReminder and the SSE emit, and the change would look applied while no
 * reminder fired and no desktop ever rewrote the file.
 */
import { and, eq } from 'drizzle-orm'
import {
  TaskFileError,
  areaFromFile,
  isTaskFilePath,
  parseTaskFile,
  relatedFromFile,
  taskIdFromPath,
  type TaskFileFields,
} from '@holi/shared'
import type { Bus } from '../bus'
import type { Db } from '../db/client'
import { folders, docs, tasks, type GitWarning } from '../db/schema'
import { completeTask, createTask, deleteTask, patchTask, type TaskPatch } from '../tasks/mutations'
import { gitBuffer, type NameStatusEntry } from './git'

export { isTaskFilePath }

export interface TaskIngestDeps {
  db: Db
  bus: Bus
}

/** The fields an inbound file write can carry, in file form. Mirrors the desktop
 * projector's DIFFABLE — the two inbound paths must agree on what a file can say. */
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

function warning(kind: GitWarning['kind'], path: string, detail?: string): GitWarning {
  return { at: new Date().toISOString(), kind, path, detail }
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/** A blob, or null when the path does not exist at that rev (a create has no base). */
async function blobText(cloneDir: string, rev: string, path: string): Promise<string | null> {
  try {
    const buf = await gitBuffer(['show', `${rev}:${path}`], cloneDir)
    if (buf.subarray(0, 8192).includes(0)) return null // binary
    return buf.toString('utf8')
  } catch {
    return null
  }
}

interface Resolvers {
  folderIdForPath: (path: string) => string | undefined
  docIdForPath: (path: string) => string | undefined
}

async function loadResolvers(db: Db, vaultId: string): Promise<Resolvers> {
  const [folderRows, docRows] = await Promise.all([
    db.select().from(folders).where(eq(folders.vaultId, vaultId)),
    db.select({ id: docs.id, path: docs.path }).from(docs).where(eq(docs.vaultId, vaultId)),
  ])
  const folderIds = new Map(folderRows.map((f) => [f.path, f.id]))
  const docIds = new Map(docRows.map((d) => [d.path, d.id]))
  return {
    folderIdForPath: (p) => folderIds.get(p),
    docIdForPath: (p) => docIds.get(p),
  }
}

/**
 * File form → record form for one field.
 *
 * An unresolvable `area` or `related[]` path **drops that field and warns** rather
 * than rejecting the whole file. This is the one place the two inbound paths
 * deliberately differ: the desktop can reject a write and rewrite the file from truth,
 * because the agent is still there to read the correction. A commit has already
 * happened, on a machine that has moved on — rejecting it would strand the record and
 * the repo in permanent disagreement with nobody to fix it.
 */
function toRecordField(
  key: (typeof DIFFABLE)[number],
  value: TaskFileFields[typeof key],
  r: Resolvers,
  path: string,
  warnings: GitWarning[],
): { ok: true; value: unknown } | { ok: false } {
  if (value === undefined) {
    // The key was deleted from the frontmatter. `undefined` reads as "not mentioned"
    // and the field would silently survive its own deletion, so clearing is explicit.
    if (key === 'tags') return { ok: true, value: [] }
    if (key === 'related') return { ok: true, value: [] }
    if (key === 'title' || key === 'status') return { ok: false } // NOT NULL: cannot clear
    return { ok: true, value: null }
  }
  try {
    if (key === 'area') return { ok: true, value: areaFromFile(value as string, r.folderIdForPath) }
    if (key === 'related') {
      return { ok: true, value: relatedFromFile(value as never, r.docIdForPath) }
    }
    return { ok: true, value }
  } catch (err) {
    if (!(err instanceof TaskFileError)) throw err
    warnings.push(warning('task-ref-unresolved', path, (err as Error).message))
    return { ok: false }
  }
}

/** Build the full record from a file — a create. */
function buildCreate(
  fields: TaskFileFields,
  description: string,
  r: Resolvers,
  path: string,
  warnings: GitWarning[],
): TaskPatch & { title: string } {
  const write: Record<string, unknown> = {}
  for (const key of DIFFABLE) {
    if (!(key in fields)) continue
    const out = toRecordField(key, fields[key], r, path, warnings)
    if (out.ok) write[key] = out.value
  }
  if (description !== '') write.description = description
  // `title` is guaranteed: parseTaskFile rejects a file without one, so it never
  // reaches here.
  return write as unknown as TaskPatch & { title: string }
}

/** Diff base-blob against head-blob, per field. The exactness of this is D34. */
function buildPatch(
  before: TaskFileFields,
  beforeDescription: string,
  fields: TaskFileFields,
  description: string,
  r: Resolvers,
  path: string,
  warnings: GitWarning[],
): { patch: TaskPatch; completing: boolean } {
  const patch: Record<string, unknown> = {}
  for (const key of DIFFABLE) {
    if (same(fields[key], before[key])) continue
    const out = toRecordField(key, fields[key], r, path, warnings)
    if (out.ok) patch[key] = out.value
  }
  if (description !== beforeDescription) patch.description = description === '' ? null : description

  // `status: done` in a file cannot distinguish "this instance is done, roll it
  // forward" from "end the series" — the ambiguity task_set exists to resolve, and a
  // remote session has no task_set. Take the only safe reading: complete it, and let
  // the server roll. (Ending a series remotely means editing `recurrence` out of the
  // frontmatter, which works and is discoverable.)
  const completing = patch.status === 'done'
  if (completing) delete patch.status
  return { patch: patch as TaskPatch, completing }
}

const findTask = async (db: Db, vaultId: string, taskId: string) =>
  (await db.select().from(tasks).where(and(eq(tasks.vaultId, vaultId), eq(tasks.id, taskId))))[0] ?? null

/**
 * Ingest one `tasks/**.md` entry. Called from `ingestEntry` BEFORE its A/M/D/R
 * dispatch — `createDoc` hardcodes `kind: 'note'`, and every inbound path that is not
 * explicitly routed elsewhere ends up there. A task file reaching it becomes a CRDT
 * note, which is the exact failure the desktop mirror spent all of slice 1 preventing.
 */
export async function ingestTaskEntry(
  deps: TaskIngestDeps,
  vaultId: string,
  cloneDir: string,
  base: string,
  head: string,
  entry: NameStatusEntry,
  warnings: GitWarning[],
  opts: { skipExisting?: boolean },
): Promise<void> {
  const { db, bus } = deps
  const ctx = { db, bus }
  const path = entry.path

  // --- D: the id is in the FILENAME. There is no blob left to read one out of.
  if (entry.status === 'D') {
    const taskId = taskIdFromPath(path)
    if (!taskId) return // a hand-written file that never became a record
    if (!(await findTask(db, vaultId, taskId))) return // already gone — not an error
    await deleteTask(ctx, vaultId, taskId) // no version (D34)
    return
  }

  const headText = await blobText(cloneDir, head, path)
  if (headText === null) return void warnings.push(warning('binary-skipped', path))

  let parsed
  try {
    parsed = parseTaskFile(headText)
  } catch (err) {
    // It changes nothing and the next export overwrites it. It must NEVER fall
    // through to createDoc.
    return void warnings.push(warning('task-file-unparseable', path, (err as Error).message))
  }

  const resolvers = await loadResolvers(db, vaultId)

  // The filename wins over the frontmatter: it is what a rename and a delete carry.
  const pathId = taskIdFromPath(path)
  const oldPathId = entry.status === 'R' && entry.oldPath ? taskIdFromPath(entry.oldPath) : undefined
  const taskId = pathId ?? parsed.id

  // --- no id anywhere: a hand-written file. Create the record; the export that
  // follows in this same sync pass renames it to its canonical path, and git renders
  // that as a rename.
  if (!taskId) {
    await createTask(ctx, vaultId, buildCreate(parsed.fields, parsed.description, resolvers, path, warnings))
    return
  }

  const existing = await findTask(db, vaultId, taskId)
  if (!existing) {
    // The vault deleted this task. Do not resurrect it from a commit that predates
    // the delete — the export in this same pass removes the file from the remote.
    return
  }
  if (opts.skipExisting) return // initial connect: vault wins, the export overwrites

  // --- the base blob is the diff base (D34). A rename reads its base at the OLD path:
  // the id suffix is stable, so a rename is just a title edit that re-derived the slug.
  const basePath = entry.status === 'R' && entry.oldPath && oldPathId === pathId ? entry.oldPath : path
  const beforeText = base ? await blobText(cloneDir, base, basePath) : null

  let before: TaskFileFields = {}
  let beforeDescription = ''
  if (beforeText !== null) {
    try {
      const b = parseTaskFile(beforeText)
      before = b.fields
      beforeDescription = b.description
    } catch {
      // An unparseable base means we cannot tell what the writer changed. Fall back to
      // an empty base: every field in the commit is treated as touched. Coarser than a
      // real diff, but it is the commit's own content — never a guess.
      before = {}
    }
  }

  const { patch, completing } = buildPatch(
    before,
    beforeDescription,
    parsed.fields,
    parsed.description,
    resolvers,
    path,
    warnings,
  )

  if (Object.keys(patch).length > 0) await patchTask(ctx, vaultId, taskId, patch)
  if (completing) await completeTask(ctx, vaultId, taskId)
}
