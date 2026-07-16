import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { provisionPersonalVault } from '../src/auth/provision'
import { createBus } from '../src/bus'
import { memberships, vaults } from '../src/db/schema'
import { createTestDb, type TestDb } from '../src/test/db'
import { seedUser } from '../src/test/fixtures'

describe('personal vault provisioning (FR-7)', () => {
  let t: TestDb
  beforeAll(async () => {
    t = await createTestDb()
  })
  afterAll(() => t.destroy())

  it('first call creates exactly one personal vault + owner membership', async () => {
    const u = await seedUser(t.db)
    const vaultId = await provisionPersonalVault(t.db, createBus(), u.id)
    const rows = await t.db
      .select()
      .from(vaults)
      .where(and(eq(vaults.ownerId, u.id), eq(vaults.kind, 'personal')))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(vaultId)
    const [m] = await t.db.select().from(memberships).where(eq(memberships.vaultId, vaultId))
    expect(m).toMatchObject({ userId: u.id, role: 'owner' })
  })

  it('is idempotent — second call returns the same vault', async () => {
    const u = await seedUser(t.db)
    const first = await provisionPersonalVault(t.db, createBus(), u.id)
    const second = await provisionPersonalVault(t.db, createBus(), u.id)
    expect(second).toBe(first)
    const rows = await t.db
      .select()
      .from(vaults)
      .where(and(eq(vaults.ownerId, u.id), eq(vaults.kind, 'personal')))
    expect(rows).toHaveLength(1)
  })

  it('DB enforces one personal vault per owner (partial unique index)', async () => {
    const u = await seedUser(t.db)
    await provisionPersonalVault(t.db, createBus(), u.id)
    await expect(
      t.db.insert(vaults).values({ name: 'sneaky', kind: 'personal', ownerId: u.id }),
    ).rejects.toThrow()
    // shared vaults are unrestricted
    await t.db.insert(vaults).values({ name: 'a', kind: 'shared', ownerId: u.id })
    await t.db.insert(vaults).values({ name: 'b', kind: 'shared', ownerId: u.id })
  })
})
