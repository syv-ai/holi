import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { ensureDevUser } from '../auth/dev'
import { exchangeGoogleCode, googleAuthUrl, upsertGoogleUser } from '../auth/google'
import { provisionPersonalVault } from '../auth/provision'
import { mintSession, revokeSession } from '../auth/sessions'
import { config } from '../config'
import { authedProcedure, publicProcedure, router } from '../trpc'

export const authRouter = router({
  beginGoogle: publicProcedure.query(() => ({ url: googleAuthUrl() })),

  /** Public OAuth client config for the desktop's system-browser flow.
   * The clientId is public by design; the secret never leaves the server. */
  oauthConfig: publicProcedure.query(() => ({
    clientId: config.google.clientId ?? null,
    workspaceDomain: config.google.workspaceDomain ?? null,
  })),

  completeGoogle: publicProcedure
    .input(
      z.object({
        code: z.string().min(1),
        codeVerifier: z.string().optional(),
        redirectUri: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const profile = await exchangeGoogleCode(input.code, {
        codeVerifier: input.codeVerifier,
        redirectUri: input.redirectUri,
      })
      const user = await upsertGoogleUser(ctx.db, profile)
      await provisionPersonalVault(ctx.db, ctx.bus, user.id)
      const token = await mintSession(ctx.db, user.id)
      return { token, user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl } }
    }),

  /** Dev-only bootstrap: provision the local dev user + personal vault and mint a
   * session, no OAuth. This is what makes `pnpm dev` land on a vault instead of an
   * empty sign-in screen. Gated off in production — it mints a session for anyone. */
  devSession: publicProcedure.mutation(async ({ ctx }) => {
    if (!config.enableDevAuth) throw new TRPCError({ code: 'NOT_FOUND' })
    const user = await ensureDevUser(ctx.db, ctx.bus)
    const token = await mintSession(ctx.db, user.id)
    return { token, user: { id: user.id, email: user.email, name: user.name, avatarUrl: null } }
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
