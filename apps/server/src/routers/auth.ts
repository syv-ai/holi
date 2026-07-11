import { z } from 'zod'
import { exchangeGoogleCode, googleAuthUrl, upsertGoogleUser } from '../auth/google'
import { mintSession, revokeSession } from '../auth/sessions'
import { authedProcedure, publicProcedure, router } from '../trpc'

export const authRouter = router({
  beginGoogle: publicProcedure.query(() => ({ url: googleAuthUrl() })),

  completeGoogle: publicProcedure
    .input(z.object({ code: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const profile = await exchangeGoogleCode(input.code)
      const user = await upsertGoogleUser(ctx.db, profile)
      const token = await mintSession(ctx.db, user.id)
      return { token, user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl } }
    }),

  session: authedProcedure.query(({ ctx }) => ctx.user),

  /** Rotate: mint a fresh token, revoke the presented one. */
  refresh: authedProcedure.mutation(async ({ ctx }) => {
    const token = await mintSession(ctx.db, ctx.user.id)
    if (ctx.token) await revokeSession(ctx.db, ctx.token)
    return { token }
  }),

  signOut: authedProcedure.mutation(async ({ ctx }) => {
    if (ctx.token) await revokeSession(ctx.db, ctx.token)
    return { ok: true }
  }),
})
