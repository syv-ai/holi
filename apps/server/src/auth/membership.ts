/** The single authorization source (PRD §Authorization): membership → role.
 * Backs the tRPC vault middleware AND Hocuspocus onAuthenticate. */
import { and, eq } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import type { Role } from '@holi/shared'
import type { Db } from '../db/client'
import { docs, memberships } from '../db/schema'

export async function resolveVaultRole(
  db: Db,
  vaultId: string,
  userId: string,
): Promise<Role | null> {
  const [row] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.vaultId, vaultId), eq(memberships.userId, userId)))
  return row?.role ?? null
}

/** Resolve a docId to its vault and assert the caller is a member. */
export async function requireDocAccess(
  db: Db,
  docId: string,
  userId: string,
): Promise<{ vaultId: string; role: Role; path: string }> {
  const [row] = await db
    .select({ vaultId: docs.vaultId, path: docs.path })
    .from(docs)
    .where(eq(docs.id, docId))
  if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
  const role = await resolveVaultRole(db, row.vaultId, userId)
  if (!role) throw new TRPCError({ code: 'FORBIDDEN' })
  return { vaultId: row.vaultId, role, path: row.path }
}
