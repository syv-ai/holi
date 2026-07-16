/** FR-7: idempotent first-sign-in personal vault. FR-8 seeding (daily
 * scaffold, AGENTS/MEMORY) is a documented stub — lands with the
 * daily-notes/agent phases. */
import { and, eq } from 'drizzle-orm'
import type { Bus } from '../bus'
import type { Db } from '../db/client'
import { vaults } from '../db/schema'
import { insertMembershipRow } from '../membership/service'

export async function provisionPersonalVault(db: Db, bus: Bus, userId: string): Promise<string> {
  const existing = await findPersonal(db, userId)
  if (existing) return existing
  try {
    const { vaultId, joined } = await db.transaction(async (tx) => {
      const [vault] = await tx
        .insert(vaults)
        .values({ name: 'Personal', kind: 'personal', ownerId: userId })
        .returning()
      const joined = await insertMembershipRow(tx, { vaultId: vault!.id, userId, role: 'owner' })
      return { vaultId: vault!.id, joined }
    })
    // Outside the tx (D51). In practice nobody is listening — this runs during sign-in,
    // before the client has a token to open a stream with — but the funnel has no
    // exceptions, because an exception is how the next writer skips it.
    if (joined) bus.emitMembership(joined, { type: 'joined', vaultId })
    return vaultId
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
