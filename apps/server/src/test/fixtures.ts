import { randomBytes } from 'node:crypto'
import { mintSession } from '../auth/sessions'
import type { Db } from '../db/client'
import { memberships, users, vaults } from '../db/schema'
import type { Role, VaultKind } from '@holi/shared'

export async function seedUser(db: Db, email = `${randomBytes(4).toString('hex')}@syv.ai`) {
  const [user] = await db
    .insert(users)
    .values({ googleSub: `sub-${randomBytes(8).toString('hex')}`, email })
    .returning()
  return user!
}

/** Vault + owner membership in one go (mirrors vaults.create). */
export async function seedVault(db: Db, ownerId: string, kind: VaultKind = 'shared', name = 'v') {
  const [vault] = await db.insert(vaults).values({ name, kind, ownerId }).returning()
  await db.insert(memberships).values({ vaultId: vault!.id, userId: ownerId, role: 'owner' })
  return vault!
}

export async function addMember(db: Db, vaultId: string, userId: string, role: Role = 'member') {
  await db.insert(memberships).values({ vaultId, userId, role })
}

export async function seedSession(db: Db, userId: string): Promise<string> {
  return mintSession(db, userId)
}
