/**
 * Atomic rename (D12, docs-only per D27). CRDT link spans are rewritten as targeted
 * Y.Text ops via the shared grammar. Live rooms receive the rewrite through the normal
 * relay path (editDocText goes through the live doc when one is open).
 *
 * "Atomic" here means *from the reader's point of view* — a link never points at a path
 * that does not exist. It does NOT mean a transaction: there is none, and there cannot
 * be one, because the rewrite goes through the live relay and no database transaction
 * can roll back a Yjs op. (This header used to claim "all SQL runs in one transaction",
 * which was never true of either function here.) What stands in for it is checking every
 * destination BEFORE moving anything — see assertFolderDestinationFree.
 */
import { and, eq, inArray, like } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import type * as Y from 'yjs'
import { formatWikiLink, parseWikiLinks, type VaultRelPath } from '@holi/shared'
import type { Bus } from '../bus'
import type { Db } from '../db/client'
import { docs, folders, linkIndex } from '../db/schema'
import type { GetLiveDoc } from '../trpc'
import { toDocMeta } from '../db/mappers'
import { ensureAncestorFolders } from '../paths'
import { editDocText } from './edit'
import { refreshLinkIndex } from './link-index'
import { takeSnapshot } from './snapshots'

/** Positioned link rewrite on a Y.Text — reverse order keeps offsets valid. */
export function rewriteLinksInYText(text: Y.Text, fromPath: string, toPath: string): number {
  const matches = parseWikiLinks(text.toString()).filter(
    (l) => l.kind === 'note' && l.target === fromPath,
  )
  for (const m of [...matches].reverse()) {
    text.delete(m.start, m.end - m.start)
    text.insert(m.start, formatWikiLink(toPath, m.label))
  }
  return matches.length
}

export interface RenameDeps {
  db: Db
  bus: Bus
  getLiveDoc: GetLiveDoc
}

/** Rewrite [[fromPath]] → [[toPath]] in every doc link_index says references
 * it (plus `extraDocIds`, e.g. the renamed doc itself for self-links), with
 * an unconditional pre-rename snapshot per touched doc. */
async function rewriteReferences(
  deps: RenameDeps,
  vaultId: string,
  fromPath: string,
  toPath: string,
  authorId: string,
  extraDocIds: string[] = [],
): Promise<void> {
  const refs = await deps.db
    .select({ srcDocId: linkIndex.srcDocId })
    .from(linkIndex)
    .where(and(eq(linkIndex.vaultId, vaultId), eq(linkIndex.targetPath, fromPath)))
  const touched = new Set([...refs.map((r) => r.srcDocId), ...extraDocIds])
  for (const srcDocId of touched) {
    let rewrote = 0
    const { before, text } = await editDocText(deps.db, deps.getLiveDoc, srcDocId, (yText) => {
      rewrote = rewriteLinksInYText(yText, fromPath, toPath)
    })
    if (rewrote === 0) continue
    await takeSnapshot(deps.db, {
      docId: srcDocId,
      state: before,
      reason: 'pre-rename',
      label: `before [[${fromPath}]] → [[${toPath}]]`,
      authorId,
    })
    await refreshLinkIndex(deps.db, vaultId, srcDocId, text)
  }
}

export async function renameNote(
  deps: RenameDeps,
  args: { vaultId: string; docId: string; newPath: VaultRelPath; authorId: string },
): Promise<void> {
  const { db } = deps
  const [doc] = await db
    .select()
    .from(docs)
    .where(and(eq(docs.id, args.docId), eq(docs.vaultId, args.vaultId)))
  if (!doc) throw new TRPCError({ code: 'NOT_FOUND' })
  const [occupied] = await db
    .select({ id: docs.id })
    .from(docs)
    .where(and(eq(docs.vaultId, args.vaultId), eq(docs.path, args.newPath)))
  if (occupied) throw new TRPCError({ code: 'CONFLICT', message: `${args.newPath} is taken` })

  await rewriteReferences(deps, args.vaultId, doc.path, args.newPath, args.authorId, [doc.id])

  await ensureAncestorFolders(db, args.vaultId, args.newPath)

  const [moved] = await db
    .update(docs)
    .set({ path: args.newPath, updatedAt: new Date() })
    .where(eq(docs.id, doc.id))
    .returning()
  deps.bus.emitDocs(args.vaultId, { type: 'renamed', doc: toDocMeta(moved!) })
}

/**
 * Every path a folder rename is about to claim, checked before it claims any of them.
 *
 * Both halves are needed. The **folder row** at the destination catches "rename `a` onto
 * `b`" — but a destination that exists only as a *prefix* of doc paths may have no folder
 * row at all, so the **doc destinations** must be checked too, or the `docs` unique
 * constraint fires mid-loop and we are back to the partial move.
 */
async function assertFolderDestinationFree(
  db: Db,
  vaultId: string,
  oldPrefix: string,
  newPath: string,
  contained: Array<{ id: string; path: string }>,
): Promise<void> {
  if (newPath === oldPrefix) return
  const [occupiedFolder] = await db
    .select({ id: folders.id })
    .from(folders)
    .where(and(eq(folders.vaultId, vaultId), eq(folders.path, newPath)))
  if (occupiedFolder) throw new TRPCError({ code: 'CONFLICT', message: `${newPath} is taken` })

  const destinations = contained.map((doc) => `${newPath}/${doc.path.slice(oldPrefix.length + 1)}`)
  if (destinations.length === 0) return
  const moving = new Set(contained.map((doc) => doc.id))
  const clashes = await db
    .select({ id: docs.id, path: docs.path })
    .from(docs)
    .where(and(eq(docs.vaultId, vaultId), inArray(docs.path, destinations)))
  // A doc that is itself moving cannot collide with its own destination.
  const blocking = clashes.find((row) => !moving.has(row.id))
  if (blocking) throw new TRPCError({ code: 'CONFLICT', message: `${blocking.path} is taken` })
}

export async function renameFolder(
  deps: RenameDeps,
  args: { vaultId: string; folderId: string; newPath: VaultRelPath; authorId: string },
): Promise<void> {
  const { db } = deps
  const [folder] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.id, args.folderId), eq(folders.vaultId, args.vaultId)))
  if (!folder) throw new TRPCError({ code: 'NOT_FOUND' })
  const oldPrefix = folder.path

  const contained = await db
    .select()
    .from(docs)
    .where(and(eq(docs.vaultId, args.vaultId), like(docs.path, `${oldPrefix}/%`)))

  // Reject before touching anything. `renameNote` has always checked its one destination
  // (line ~86); this checked NOTHING, so renaming `a` onto an existing `b` silently
  // MERGED them, and a contained-doc collision surfaced only when the `docs` unique
  // constraint fired **mid-loop** — after earlier docs had already been moved and their
  // links rewritten. A half-moved folder, and no way back.
  //
  // Up-front is the only defence available: there is no transaction here and there
  // cannot be one, because `rewriteReferences` edits CRDT docs through the live relay
  // and no database transaction can roll that back. Checking first means the loop only
  // ever runs when it is going to finish.
  await assertFolderDestinationFree(db, args.vaultId, oldPrefix, args.newPath, contained)

  // move contained docs one by one through the same machinery (links rewrite,
  // snapshots, link_index) — tasks.area follows automatically via folder id (D27)
  for (const doc of contained) {
    const newDocPath = `${args.newPath}/${doc.path.slice(oldPrefix.length + 1)}` as VaultRelPath
    await rewriteReferences(deps, args.vaultId, doc.path, newDocPath, args.authorId, [doc.id])
    await db.update(docs).set({ path: newDocPath, updatedAt: new Date() }).where(eq(docs.id, doc.id))
    const [moved] = await db.select().from(docs).where(eq(docs.id, doc.id))
    deps.bus.emitDocs(args.vaultId, { type: 'renamed', doc: toDocMeta(moved!) })
  }

  // descendant folder rows follow the prefix; the folder row itself keeps its id
  const descendants = await db
    .select()
    .from(folders)
    .where(and(eq(folders.vaultId, args.vaultId), like(folders.path, `${oldPrefix}/%`)))
  for (const d of descendants) {
    const p = `${args.newPath}/${d.path.slice(oldPrefix.length + 1)}`
    await db.update(folders).set({ path: p, updatedAt: new Date() }).where(eq(folders.id, d.id))
  }
  await db
    .update(folders)
    .set({ path: args.newPath, updatedAt: new Date() })
    .where(eq(folders.id, folder.id))
}
