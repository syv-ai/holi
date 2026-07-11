import { initTRPC, TRPCError } from '@trpc/server'
import type { IncomingMessage } from 'node:http'
import { resolveSession, type SessionUser } from './auth/sessions'
import type { Bus } from './bus'
import type { Db } from './db/client'

export interface Context {
  db: Db
  bus: Bus
  user: SessionUser | null
  token: string | null
}

export function bearerToken(req: Pick<IncomingMessage, 'headers'>): string | null {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  return header.slice('Bearer '.length) || null
}

/** Adapter-facing factory: main.ts partially applies { db, bus }. */
export function makeCreateContext(deps: { db: Db; bus: Bus }) {
  return async ({ req }: { req: IncomingMessage }): Promise<Context> => {
    const token = bearerToken(req)
    const user = token ? await resolveSession(deps.db, token) : null
    return { ...deps, user, token }
  }
}

const t = initTRPC.context<Context>().create()

export const router = t.router
export const publicProcedure = t.procedure

export const authedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' })
  return next({ ctx: { ...ctx, user: ctx.user } })
})
