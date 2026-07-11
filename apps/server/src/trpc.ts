import { initTRPC, TRPCError } from '@trpc/server'
import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import { resolveVaultRole } from './auth/membership'
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

const vaultInput = z.object({ vaultId: z.string().uuid() })

/** Every vault-scoped procedure funnels through this middleware — the role in
 * ctx comes from the DB, never from the client (PRD §Authorization). */
export const vaultProcedure = authedProcedure.input(vaultInput).use(async ({ ctx, input, next }) => {
  const role = await resolveVaultRole(ctx.db, input.vaultId, ctx.user.id)
  if (!role) throw new TRPCError({ code: 'FORBIDDEN', message: 'not a member of this vault' })
  return next({ ctx: { ...ctx, vaultId: input.vaultId, role } })
})

export const ownerProcedure = vaultProcedure.use(({ ctx, next }) => {
  if (ctx.role !== 'owner') throw new TRPCError({ code: 'FORBIDDEN', message: 'owner role required' })
  return next()
})
