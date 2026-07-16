import { and, eq } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import * as Y from 'yjs'
import { toDocMeta } from '../db/mappers'
import { docs, linkIndex, yjsDocs } from '../db/schema'
import { ensureAncestorFolders, safePath } from '../paths'
import { router, vaultProcedure } from '../trpc'
import { renameFolder, renameNote } from '../yjs/rename'
import { getOrCreateDaily, sweepDaily } from '../daily/service'

export const notesRouter = router({
  create: vaultProcedure
    .input(z.object({ path: z.string(), kind: z.enum(['note', 'daily']) }))
    .mutation(async ({ ctx, input }) => {
      const path = safePath(input.path)
      const doc = await ctx.db.transaction(async (tx) => {
        await ensureAncestorFolders(tx, ctx.vaultId, path)
        const [row] = await tx
          .insert(docs)
          .values({ vaultId: ctx.vaultId, path, kind: input.kind })
          .onConflictDoNothing()
          .returning()
        if (!row) throw new TRPCError({ code: 'CONFLICT', message: `a doc already exists at ${path}` })
        await tx.insert(yjsDocs).values({ docId: row.id, state: Y.encodeStateAsUpdate(new Y.Doc()) })
        return row
      })
      const meta = toDocMeta(doc)
      ctx.bus.emitDocs(ctx.vaultId, { type: 'created', doc: meta })
      return meta
    }),

  /** Today's daily note, idempotently (D44/D45). `localDate` is the caller's — the
   * server never computes "today" for a device it cannot locate. */
  getOrCreateDaily: vaultProcedure
    .input(z.object({ localDate: z.string() }))
    .mutation(async ({ ctx, input }) =>
      getOrCreateDaily({ db: ctx.db, bus: ctx.bus }, { vaultId: ctx.vaultId, localDate: input.localDate }),
    ),

  /** Archive prior-day dailies into `journal/`, GC untouched unreferenced stubs.
   * Idempotent — the client kicks it on every activation. */
  sweepDaily: vaultProcedure
    .input(z.object({ localDate: z.string() }))
    .mutation(async ({ ctx, input }) =>
      sweepDaily(
        { db: ctx.db, bus: ctx.bus, getLiveDoc: ctx.getLiveDoc },
        { vaultId: ctx.vaultId, localDate: input.localDate, authorId: ctx.user.id },
      ),
    ),

  /** No ref cascades — dangling related[] ids render tombstones client-side (D27). */
  delete: vaultProcedure
    .input(z.object({ docId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .delete(docs)
        .where(and(eq(docs.id, input.docId), eq(docs.vaultId, ctx.vaultId)))
        .returning()
      if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
      ctx.bus.emitDocs(ctx.vaultId, { type: 'deleted', doc: toDocMeta(row) })
      return { ok: true }
    }),

  rename: vaultProcedure
    .input(z.object({ docId: z.string().uuid(), newPath: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const newPath = safePath(input.newPath)
      await renameNote(
        { db: ctx.db, bus: ctx.bus, getLiveDoc: ctx.getLiveDoc },
        { vaultId: ctx.vaultId, docId: input.docId, newPath, authorId: ctx.user.id },
      )
      return { ok: true }
    }),

  renameFolder: vaultProcedure
    .input(z.object({ folderId: z.string().uuid(), newPath: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const newPath = safePath(input.newPath)
      await renameFolder(
        { db: ctx.db, bus: ctx.bus, getLiveDoc: ctx.getLiveDoc },
        { vaultId: ctx.vaultId, folderId: input.folderId, newPath, authorId: ctx.user.id },
      )
      return { ok: true }
    }),

  /** Docs referencing this path, via link_index — surfaced before delete. */
  backrefs: vaultProcedure
    .input(z.object({ path: z.string() }))
    .query(async ({ ctx, input }) => {
      const path = safePath(input.path)
      return ctx.db
        .select({ srcDocId: linkIndex.srcDocId, occurrences: linkIndex.occurrences })
        .from(linkIndex)
        .where(and(eq(linkIndex.vaultId, ctx.vaultId), eq(linkIndex.targetPath, path)))
    }),
})
