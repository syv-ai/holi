/** Foreign-commit ingestion: diff base..head per file, mutate docs through the
 * live-room-aware editDocText so open editors receive remote-session edits
 * like a teammate's. Design: docs/specs/2026-07-13-vault-git-mirror-design.md. */
import { and, eq } from 'drizzle-orm'
import * as Y from 'yjs'
import { applyTextDiff, isLocalOnlyPath, isTaskFilePath, vaultRelPath, YDOC_TEXT_KEY } from '@holi/shared'
import type { Bus } from '../bus'
import type { Db } from '../db/client'
import { docs, yjsDocs, type GitWarning } from '../db/schema'
import { ensureAncestorFolders } from '../paths'
import type { GetLiveDoc } from '../trpc'
import { loadDocState } from '../yjs/doc-store'
import { editDocText } from '../yjs/edit'
import { refreshLinkIndex } from '../yjs/link-index'
import { takeSnapshot } from '../yjs/snapshots'
import { git, gitBuffer, parseNameStatusZ, type NameStatusEntry } from './git'
import { ingestTaskEntry } from './task-ingest'

export interface IngestDeps {
  db: Db
  getLiveDoc: GetLiveDoc
  /** Task ingest mutates records, and every task mutation emits on the bus — that SSE
   * is what makes a connected desktop rewrite the file. */
  bus: Bus
}

/** Validate a repo path for vault use; null when hostile/invalid. */
export function safeIngestPath(raw: string): string | null {
  try {
    return vaultRelPath(raw)
  } catch {
    return null
  }
}

function warning(kind: GitWarning['kind'], path: string, detail?: string): GitWarning {
  return { at: new Date().toISOString(), kind, path, detail }
}

async function blobAt(cloneDir: string, rev: string, path: string): Promise<Buffer> {
  return gitBuffer(['show', `${rev}:${path}`], cloneDir)
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0)
}

async function findDoc(db: Db, vaultId: string, path: string) {
  const [row] = await db
    .select()
    .from(docs)
    .where(and(eq(docs.vaultId, vaultId), eq(docs.path, path)))
  return row ?? null
}

async function createDoc(deps: IngestDeps, vaultId: string, path: string, text: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    await ensureAncestorFolders(tx, vaultId, path)
    const [row] = await tx.insert(docs).values({ vaultId, path, kind: 'note' }).onConflictDoNothing().returning()
    if (!row) return
    const ydoc = new Y.Doc()
    ydoc.getText(YDOC_TEXT_KEY).insert(0, text)
    await tx.insert(yjsDocs).values({ docId: row.id, state: Y.encodeStateAsUpdate(ydoc) })
  })
  const doc = await findDoc(deps.db, vaultId, path)
  if (doc) await refreshLinkIndex(deps.db, vaultId, doc.id, text)
}

/** Patch an existing doc: pre-snapshot, positioned diff, link_index refresh.
 * Returns true when the live text had diverged from the git base. */
async function patchDoc(
  deps: IngestDeps,
  vaultId: string,
  docId: string,
  baseText: string,
  nextText: string,
): Promise<boolean> {
  const preState = await loadDocState(deps.db, docId)
  if (preState) {
    await takeSnapshot(deps.db, {
      docId,
      state: preState,
      reason: 'pre-git-ingest',
      label: 'before remote-session changes merged',
    })
  }
  let diverged = false
  const { text } = await editDocText(deps.db, deps.getLiveDoc, docId, (yText) => {
    diverged = applyTextDiff(yText, baseText, nextText)
  })
  await refreshLinkIndex(deps.db, vaultId, docId, text)
  return diverged
}

export interface IngestOptions {
  /** Initial-connect mode: never touch paths that already have a doc
   * (vault-wins collision policy — the export overwrite follows). */
  skipExisting?: boolean
}

async function ingestEntry(
  deps: IngestDeps,
  vaultId: string,
  cloneDir: string,
  base: string,
  head: string,
  entry: NameStatusEntry,
  warnings: GitWarning[],
  opts: IngestOptions,
): Promise<void> {
  const path = safeIngestPath(entry.path)
  if (!path) return void warnings.push(warning('unsafe-path', entry.path))
  if (isLocalOnlyPath(path)) return void warnings.push(warning('local-file-skipped', path))

  // Tasks are records, not CRDT docs — they ingest against the `tasks` table.
  //
  // This branch sits BEFORE the A/M/D/R dispatch, not inside it, and that placement is
  // the whole point: `createDoc` below hardcodes `kind: 'note'`, and A, M, and
  // R-treated-as-A each reach it by a different route. A task file that fell through
  // any one of them would become a CRDT note — the exact failure the desktop mirror
  // spent all of slice 1 preventing, arriving through the other door.
  if (isTaskFilePath(path)) {
    await ingestTaskEntry(
      { db: deps.db, bus: deps.bus },
      vaultId,
      cloneDir,
      base,
      head,
      { ...entry, path },
      warnings,
      opts,
    )
    return
  }

  if (opts.skipExisting && (await findDoc(deps.db, vaultId, path))) return

  if (entry.status === 'D') {
    const doc = await findDoc(deps.db, vaultId, path)
    // NOTE: no pre-delete snapshot — yjs_snapshots cascades on doc delete (same as notes.delete).
    if (doc) await deps.db.delete(docs).where(eq(docs.id, doc.id))
    return
  }

  const headBlob = await blobAt(cloneDir, head, path)
  if (isBinary(headBlob)) return void warnings.push(warning('binary-skipped', path))
  const nextText = headBlob.toString('utf8')

  if (entry.status === 'A') {
    const existing = await findDoc(deps.db, vaultId, path)
    if (existing) {
      // base didn't know this path but the vault has it → merge as edit against empty base
      const diverged = await patchDoc(deps, vaultId, existing.id, '', nextText)
      if (diverged) warnings.push(warning('diverged-ingest', path))
    } else {
      await createDoc(deps, vaultId, path, nextText)
    }
    return
  }

  if (entry.status === 'R') {
    const oldPath = safeIngestPath(entry.oldPath!)
    const doc = oldPath ? await findDoc(deps.db, vaultId, oldPath) : null
    if (!doc) {
      // nothing to move — treat as an add
      await ingestEntry(deps, vaultId, cloneDir, base, head, { status: 'A', path: entry.path }, warnings, opts)
      return
    }
    const occupied = await findDoc(deps.db, vaultId, path)
    if (occupied) {
      warnings.push(warning('rename-target-occupied', path, `kept ${oldPath}`))
    } else {
      // identity-preserving move; NO link rewrite (the commit carries its own link edits)
      await ensureAncestorFolders(deps.db, vaultId, path)
      await deps.db.update(docs).set({ path, updatedAt: new Date() }).where(eq(docs.id, doc.id))
    }
    const target = occupied ?? doc
    if ((entry.similarity ?? 100) < 100 || occupied) {
      const baseBlob = await blobAt(cloneDir, base, entry.oldPath!)
      if (!isBinary(baseBlob)) {
        const diverged = await patchDoc(deps, vaultId, target.id, baseBlob.toString('utf8'), nextText)
        if (diverged) warnings.push(warning('diverged-ingest', path))
      }
    }
    return
  }

  // 'M'
  const doc = await findDoc(deps.db, vaultId, path)
  if (!doc) {
    await createDoc(deps, vaultId, path, nextText)
    return
  }
  const baseBlob = await blobAt(cloneDir, base, path)
  const baseText = isBinary(baseBlob) ? '' : baseBlob.toString('utf8')
  const diverged = await patchDoc(deps, vaultId, doc.id, baseText, nextText)
  if (diverged) warnings.push(warning('diverged-ingest', path))
}

/** Ingest every file change in base..head. Returns accumulated warnings. */
export async function ingestRange(
  deps: IngestDeps,
  vaultId: string,
  cloneDir: string,
  base: string,
  head: string,
  opts: IngestOptions = {},
): Promise<GitWarning[]> {
  const out = await git(['diff', '--name-status', '-M', '-z', base, head], cloneDir)
  const entries = parseNameStatusZ(out)
  const warnings: GitWarning[] = []
  for (const entry of entries) {
    await ingestEntry(deps, vaultId, cloneDir, base, head, entry, warnings, opts)
  }
  return warnings
}
