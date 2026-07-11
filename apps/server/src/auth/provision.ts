/** FR-7: idempotent first-sign-in personal vault. FR-8 seeding (daily
 * scaffold, AGENTS/MEMORY) is a documented stub — lands with the
 * daily-notes/agent phases. */
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { memberships, vaults } from '../db/schema'

export async function provisionPersonalVault(db: Db, userId: string): Promise<string> {
  const existing = await findPersonal(db, userId)
  if (existing) return existing
  try {
    return await db.transaction(async (tx) => {
      const [vault] = await tx
        .insert(vaults)
        .values({ name: 'Personal', kind: 'personal', ownerId: userId })
        .returning()
      await tx.insert(memberships).values({ vaultId: vault!.id, userId, role: 'owner' })
      return vault!.id
    })
  } catch (err) {
    // concurrent first sign-in lost the race on vaults_personal_owner_idx
    const raced = await findPersonal(db, userId)
    if (raced) return raced
    throw err
  }
}

async function findPersonal(db: Db, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: vaults.id })
    .from(vaults)
    .where(and(eq(vaults.ownerId, userId), eq(vaults.kind, 'personal')))
  return row?.id ?? null
}
