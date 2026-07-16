import { initTRPC, TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'
import type { IncomingMessage } from 'node:http'
import type * as Y from 'yjs'
import { z } from 'zod'
import { resolveVaultRole } from './auth/membership'
import { resolveSession, type SessionUser } from './auth/sessions'
import type { Bus } from './bus'
import type { Db } from './db/client'
import { vaults } from './db/schema'

/** Look up an open Hocuspocus room's live doc (null when no room is open). */
export type GetLiveDoc = (docId: string) => Y.Doc | null

export interface Context {
  db: Db
  bus: Bus
  getLiveDoc: GetLiveDoc
  user: SessionUser | null
  token: string | null
}

export function bearerToken(req: Pick<IncomingMessage, 'headers'>): string | null {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  return header.slice('Bearer '.length) || null
}

/** Adapter-facing factory: main.ts partially applies { db, bus, getLiveDoc }. */
export function makeCreateContext(deps: { db: Db; bus: Bus; getLiveDoc: GetLiveDoc }) {
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

/**
 * A vault id that has been *proven* to belong to a shared vault (D49).
 *
 * The brand exists so the personal-vault block cannot be forgotten. Membership mutations
 * take a `SharedVaultId`, and the only thing that produces one is the middleware below —
 * so an op that skips the kind check does not compile. `invite` and `transferOwnership`
 * shipped without the check twice; a rule enforced by remembering to write an `if` is a
 * rule that eventually isn't.
 */
export type SharedVaultId = string & { readonly __sharedVault: unique symbol }

/** The hard block. Kept a plain function rather than a shared middleware so the two
 * procedures below stay fully typed (a reusable tRPC middleware would need `any` at the
 * `next` seam, which is a poor trade in the one place whose job is type safety).
 *
 * Why this matters beyond FR-14: daily notes assume a personal vault has exactly one
 * owner and therefore exactly one clock (D44/D45). A second member there makes "today"
 * ambiguous — the very problem personal-only scoping exists to avoid.
 */
async function assertSharedVault(db: Db, vaultId: string): Promise<void> {
  const [vault] = await db.select({ kind: vaults.kind }).from(vaults).where(eq(vaults.id, vaultId))
  if (!vault) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such vault' })
  if (vault.kind !== 'shared') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'a personal vault has exactly one member and cannot be shared',
    })
  }
}

/** Vault-scoped, shared-vault-only. */
export const sharedVaultProcedure = vaultProcedure.use(async ({ ctx, next }) => {
  await assertSharedVault(ctx.db, ctx.vaultId)
  return next({ ctx: { ...ctx, vaultId: ctx.vaultId as SharedVaultId } })
})

/** Owner-only *and* shared-vault-only — every membership mutation. Built on
 * `ownerProcedure` so the owner rule stays defined in exactly one place. */
export const sharedOwnerProcedure = ownerProcedure.use(async ({ ctx, next }) => {
  await assertSharedVault(ctx.db, ctx.vaultId)
  return next({ ctx: { ...ctx, vaultId: ctx.vaultId as SharedVaultId } })
})
