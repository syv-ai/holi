import { on } from 'node:events'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { DocsEvent } from '../bus'
import { toDocMeta, toFolder, toVault } from '../db/mappers'
import { docs, folders, memberships, vaults } from '../db/schema'
import { insertMembershipRow } from '../membership/service'
import { authedProcedure, ownerProcedure, router, vaultProcedure } from '../trpc'

export const vaultsRouter = router({
  list: authedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({ vault: vaults })
      .from(memberships)
      .innerJoin(vaults, eq(vaults.id, memberships.vaultId))
      .where(eq(memberships.userId, ctx.user.id))
    return rows.map((r) => toVault(r.vault))
  }),

  get: vaultProcedure.query(async ({ ctx }) => {
    const [row] = await ctx.db.select().from(vaults).where(eq(vaults.id, ctx.vaultId))
    return toVault(row!)
  }),

  create: authedProcedure
    .input(z.object({ name: z.string().min(1), kind: z.enum(['shared']).default('shared') }))
    .mutation(async ({ ctx, input }) => {
      const { vault, joined } = await ctx.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(vaults)
          .values({ name: input.name, kind: input.kind, ownerId: ctx.user.id })
          .returning()
        const joined = await insertMembershipRow(tx, {
          vaultId: row!.id,
          userId: ctx.user.id,
          role: 'owner',
        })
        return { vault: toVault(row!), joined }
      })
      // Outside the tx (D51) — your other windows learn about a vault that exists.
      if (joined) ctx.bus.emitMembership(joined, { type: 'joined', vaultId: vault.id })
      return vault
    }),

  rename: ownerProcedure
    .input(z.object({ name: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .update(vaults)
        .set({ name: input.name, updatedAt: new Date() })
        .where(eq(vaults.id, ctx.vaultId))
        .returning()
      return toVault(row!)
    }),

  setTheme: ownerProcedure
    .input(z.object({ theme: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .update(vaults)
        .set({ theme: input.theme, updatedAt: new Date() })
        .where(eq(vaults.id, ctx.vaultId))
        .returning()
      return toVault(row!)
    }),

  delete: ownerProcedure.mutation(async ({ ctx }) => {
    await ctx.db.delete(vaults).where(eq(vaults.id, ctx.vaultId)) // cascades per schema
    return { ok: true }
  }),

  /** File-tree source: folder identity rows + doc metadata (D27). */
  listDocs: vaultProcedure.query(async ({ ctx }) => {
    const [docRows, folderRows] = await Promise.all([
      ctx.db.select().from(docs).where(eq(docs.vaultId, ctx.vaultId)),
      ctx.db.select().from(folders).where(eq(folders.vaultId, ctx.vaultId)),
    ])
    return { docs: docRows.map(toDocMeta), folders: folderRows.map(toFolder) }
  }),

  /** (S) Live doc-metadata changes so the file tree updates without polling. */
  watchDocs: vaultProcedure.subscription(async function* ({ ctx, signal }) {
    for await (const [event] of on(ctx.bus, `docs:${ctx.vaultId}`, { signal })) {
      yield event as DocsEvent
    }
  }),
})
