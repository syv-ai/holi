/**
 * Atomic rename (D12, docs-only per D27). All SQL runs in one transaction;
 * CRDT link spans are rewritten as targeted Y.Text ops via the shared
 * grammar. Live rooms receive the rewrite through the normal relay path
 * (editDocText goes through the live doc when one is open).
 */
import { and, eq, like } from 'drizzle-orm'
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

  // move contained docs one by one through the same machinery (links rewrite,
  // snapshots, link_index) — tasks.area follows automatically via folder id (D27)
  const contained = await db
    .select()
    .from(docs)
    .where(and(eq(docs.vaultId, args.vaultId), like(docs.path, `${oldPrefix}/%`)))
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
