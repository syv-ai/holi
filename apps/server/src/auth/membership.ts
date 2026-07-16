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

/**
 * Every vault a user is in — the *set* form of `resolveVaultRole`, and the gate for the
 * user-scoped event stream (D50), which has no single vault to check a role against:
 * membership there is a subscription set, not an admission check.
 *
 * The same predicate `vaults.list` runs (memberships by user, served by
 * `memberships_user_idx`); that one projects vault rows, this projects ids. Two answers
 * to "which vaults is this user in" is how the stream ends up subscribed to a set the
 * API disagrees with — so if one changes, change both.
 */
export async function listVaultIdsForUser(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ vaultId: memberships.vaultId })
    .from(memberships)
    .where(eq(memberships.userId, userId))
  return rows.map((r) => r.vaultId)
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
