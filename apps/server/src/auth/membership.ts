/** The single authorization source (PRD §Authorization): membership → role.
 * Backs the tRPC vault middleware AND Hocuspocus onAuthenticate. */
import { and, eq } from 'drizzle-orm'
import type { Role } from '@holi/shared'
import type { Db } from '../db/client'
import { memberships } from '../db/schema'

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
