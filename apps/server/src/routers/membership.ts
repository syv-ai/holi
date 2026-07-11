import { and, eq, ne } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { Db } from '../db/client'
import { memberships, users, vaults } from '../db/schema'
import { ownerProcedure, router, vaultProcedure } from '../trpc'

export const membershipRouter = router({
  list: vaultProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        userId: memberships.userId,
        role: memberships.role,
        email: users.email,
        name: users.name,
        avatarUrl: users.avatarUrl,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.vaultId, ctx.vaultId))
    return rows
  }),

  /** Owner invites by email; a stub users row is created if the invitee has
   * never signed in (claimed on first Google sign-in — see upsertGoogleUser). */
  invite: ownerProcedure
    .input(z.object({ email: z.string().email(), role: z.enum(['owner', 'member']) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const [existing] = await tx.select().from(users).where(eq(users.email, input.email))
        const user =
          existing ??
          (await tx
            .insert(users)
            .values({ googleSub: `pending:${input.email}`, email: input.email })
            .returning())[0]!
        await tx
          .insert(memberships)
          .values({ vaultId: ctx.vaultId, userId: user.id, role: input.role, invitedBy: ctx.user.id })
          .onConflictDoNothing()
        return { userId: user.id }
      })
    }),

  setRole: ownerProcedure
    .input(z.object({ userId: z.string().uuid(), role: z.enum(['owner', 'member']) }))
    .mutation(async ({ ctx, input }) => {
      if (input.role === 'member') await assertNotLastOwner(ctx.db, ctx.vaultId, input.userId)
      await ctx.db
        .update(memberships)
        .set({ role: input.role })
        .where(and(eq(memberships.vaultId, ctx.vaultId), eq(memberships.userId, input.userId)))
      return { ok: true }
    }),

  remove: ownerProcedure
    .input(z.object({ userId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertNotLastOwner(ctx.db, ctx.vaultId, input.userId)
      await ctx.db
        .delete(memberships)
        .where(and(eq(memberships.vaultId, ctx.vaultId), eq(memberships.userId, input.userId)))
      return { ok: true }
    }),

  leave: vaultProcedure.mutation(async ({ ctx }) => {
    if (ctx.role === 'owner') {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'owner must transfer ownership first' })
    }
    await ctx.db
      .delete(memberships)
      .where(and(eq(memberships.vaultId, ctx.vaultId), eq(memberships.userId, ctx.user.id)))
    return { ok: true }
  }),

  transferOwnership: ownerProcedure
    .input(z.object({ toUserId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.transaction(async (tx) => {
        const [target] = await tx
          .select()
          .from(memberships)
          .where(and(eq(memberships.vaultId, ctx.vaultId), eq(memberships.userId, input.toUserId)))
        if (!target) throw new TRPCError({ code: 'BAD_REQUEST', message: 'target is not a member' })
        await tx
          .update(memberships)
          .set({ role: 'owner' })
          .where(and(eq(memberships.vaultId, ctx.vaultId), eq(memberships.userId, input.toUserId)))
        await tx
          .update(memberships)
          .set({ role: 'member' })
          .where(and(eq(memberships.vaultId, ctx.vaultId), eq(memberships.userId, ctx.user.id)))
        await tx.update(vaults).set({ ownerId: input.toUserId }).where(eq(vaults.id, ctx.vaultId))
      })
      return { ok: true }
    }),
})

async function assertNotLastOwner(db: Db, vaultId: string, userId: string) {
  const others = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.vaultId, vaultId), eq(memberships.role, 'owner'), ne(memberships.userId, userId)))
  if (others.length === 0) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'cannot remove the last owner' })
  }
}
