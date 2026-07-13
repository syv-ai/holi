import { desc, eq } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import * as Y from 'yjs'
import { z } from 'zod'
import { requireDocAccess } from '../auth/membership'
import { yjsSnapshots } from '../db/schema'
import { authedProcedure, router } from '../trpc'
import { docFromState, docText, loadDocState } from '../yjs/doc-store'
import { editDocText, replaceAllText } from '../yjs/edit'
import { refreshLinkIndex } from '../yjs/link-index'
import { takeSnapshot } from '../yjs/snapshots'

export const snapshotsRouter = router({
  /** The timeline — labels surface the D26 auto-snapshot restore points. */
  list: authedProcedure
    .input(z.object({ docId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await requireDocAccess(ctx.db, input.docId, ctx.user.id)
      return ctx.db
        .select({
          id: yjsSnapshots.id,
          takenAt: yjsSnapshots.takenAt,
          reason: yjsSnapshots.reason,
          label: yjsSnapshots.label,
          authorId: yjsSnapshots.authorId,
        })
        .from(yjsSnapshots)
        .where(eq(yjsSnapshots.docId, input.docId))
        .orderBy(desc(yjsSnapshots.takenAt))
    }),

  /** Pre-agent-write snapshot — the bridge calls this at turn open (agent PRD
   * §Merge safety net). Live relay state when the doc has an open room. */
  take: authedProcedure
    .input(z.object({ docId: z.string().uuid(), label: z.string().max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      await requireDocAccess(ctx.db, input.docId, ctx.user.id)
      const live = ctx.getLiveDoc(input.docId)
      const state = live ? Y.encodeStateAsUpdate(live) : await loadDocState(ctx.db, input.docId)
      if (!state) throw new TRPCError({ code: 'NOT_FOUND' })
      await takeSnapshot(ctx.db, {
        docId: input.docId,
        state,
        reason: 'pre-agent-write',
        label: input.label ?? 'before Claude edited',
        authorId: ctx.user.id,
      })
      return { ok: true }
    }),

  /** D26 one-click restore: pre-restore snapshot, then rewrite text to the
   * snapshot's text as normal ops (merges/propagates, no hard overwrite). */
  restore: authedProcedure
    .input(z.object({ docId: z.string().uuid(), snapshotId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { vaultId } = await requireDocAccess(ctx.db, input.docId, ctx.user.id)
      const [snap] = await ctx.db
        .select()
        .from(yjsSnapshots)
        .where(eq(yjsSnapshots.id, input.snapshotId))
      if (!snap || snap.docId !== input.docId) throw new TRPCError({ code: 'NOT_FOUND' })
      const targetText = docText(docFromState(snap.state))

      const { before, after } = await editDocText(ctx.db, ctx.getLiveDoc, input.docId, (text) =>
        replaceAllText(text, targetText),
      )
      await takeSnapshot(ctx.db, {
        docId: input.docId,
        state: before,
        reason: 'pre-restore',
        label: 'before restoring an older version',
        authorId: ctx.user.id,
      })
      await refreshLinkIndex(ctx.db, vaultId, input.docId, targetText)
      return { ok: true, restoredState: after.length }
    }),
})
