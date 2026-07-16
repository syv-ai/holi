import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { memberships, users } from '../db/schema'
import {
  inviteMember,
  leaveVault,
  removeMember,
  setMemberRole,
  transferOwnership,
} from '../membership/service'
import { router, sharedOwnerProcedure, sharedVaultProcedure, vaultProcedure } from '../trpc'

const role = z.enum(['owner', 'member'])

/** Thin over `membership/service.ts`. Every mutation is `sharedOwnerProcedure` (or
 * `sharedVaultProcedure` for `leave`, which is yours to do) — that is what supplies the
 * `SharedVaultId` the service demands, and what keeps a personal vault unshareable (D49). */
export const membershipRouter = router({
  /** Deliberately `vaultProcedure`, not shared-only: reading your personal vault's single
   * membership row is harmless, and FR-14 disables invite/leave/transfer, not looking. */
  list: vaultProcedure.query(async ({ ctx }) => {
    return ctx.db
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
  }),

  /** Owner invites by email; a stub users row is created if the invitee has
   * never signed in (claimed on first Google sign-in — see upsertGoogleUser). */
  invite: sharedOwnerProcedure
    .input(z.object({ email: z.string().email(), role }))
    .mutation(({ ctx, input }) =>
      inviteMember(ctx.db, {
        vaultId: ctx.vaultId,
        email: input.email,
        role: input.role,
        invitedBy: ctx.user.id,
      }),
    ),

  setRole: sharedOwnerProcedure
    .input(z.object({ userId: z.string().uuid(), role }))
    .mutation(async ({ ctx, input }) => {
      await setMemberRole(ctx.db, { vaultId: ctx.vaultId, userId: input.userId, role: input.role })
      return { ok: true }
    }),

  remove: sharedOwnerProcedure
    .input(z.object({ userId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await removeMember(ctx.db, { vaultId: ctx.vaultId, userId: input.userId })
      return { ok: true }
    }),

  /** Any member may leave — it needs no owner rights, only a shared vault. */
  leave: sharedVaultProcedure.mutation(async ({ ctx }) => {
    await leaveVault(ctx.db, { vaultId: ctx.vaultId, userId: ctx.user.id, role: ctx.role })
    return { ok: true }
  }),

  transferOwnership: sharedOwnerProcedure
    .input(z.object({ toUserId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await transferOwnership(ctx.db, {
        vaultId: ctx.vaultId,
        fromUserId: ctx.user.id,
        toUserId: input.toUserId,
      })
      return { ok: true }
    }),
})
