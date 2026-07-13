/** User-level GitHub account linking. Vault-level repo wiring is routers/git.ts. */
import { eq } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import type { GithubOAuth } from '../git/oauth'
import { githubConnections } from '../db/schema'
import { authedProcedure, router } from '../trpc'

export function makeGithubRouter(oauth: GithubOAuth | null) {
  return router({
    /** Returns the URL the desktop opens in the system browser. */
    startConnect: authedProcedure.mutation(({ ctx }) => {
      if (!oauth)
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'GitHub OAuth is not configured on the server' })
      return { url: oauth.authorizeUrl(ctx.user.id) }
    }),

    connectionStatus: authedProcedure.query(async ({ ctx }) => {
      const [row] = await ctx.db
        .select({ githubLogin: githubConnections.githubLogin })
        .from(githubConnections)
        .where(eq(githubConnections.userId, ctx.user.id))
      return row ? { connected: true as const, login: row.githubLogin } : { connected: false as const }
    }),

    disconnect: authedProcedure.mutation(async ({ ctx }) => {
      await ctx.db.delete(githubConnections).where(eq(githubConnections.userId, ctx.user.id))
      return { ok: true }
    }),
  })
}
