import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { perUserState } from '../db/schema'
import { router, vaultProcedure } from '../trpc'

const scoped = (ctx: { vaultId: string; user: { id: string } }, key?: string) => {
  const base = [eq(perUserState.userId, ctx.user.id), eq(perUserState.vaultId, ctx.vaultId)]
  return key === undefined ? and(...base) : and(...base, eq(perUserState.key, key))
}

export const userStateRouter = router({
  get: vaultProcedure.input(z.object({ key: z.string() })).query(async ({ ctx, input }) => {
    const [row] = await ctx.db.select().from(perUserState).where(scoped(ctx, input.key))
    return row?.value ?? null
  }),
  getAll: vaultProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(perUserState).where(scoped(ctx))
    return Object.fromEntries(rows.map((r) => [r.key, r.value]))
  }),
  set: vaultProcedure
    .input(z.object({ key: z.string(), value: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .insert(perUserState)
        .values({ userId: ctx.user.id, vaultId: ctx.vaultId, key: input.key, value: input.value })
        .onConflictDoUpdate({
          target: [perUserState.userId, perUserState.vaultId, perUserState.key],
          set: { value: input.value, updatedAt: new Date() },
        })
      return { ok: true }
    }),
  delete: vaultProcedure.input(z.object({ key: z.string() })).mutation(async ({ ctx, input }) => {
    await ctx.db.delete(perUserState).where(scoped(ctx, input.key))
    return { ok: true }
  }),
})
