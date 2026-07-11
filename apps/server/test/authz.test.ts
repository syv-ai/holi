import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveVaultRole } from '../src/auth/membership'
import { vaultsRouter } from '../src/routers/vaults'
import { createBus } from '../src/bus'
import { createTestDb, type TestDb } from '../src/test/db'
import { addMember, seedUser, seedVault } from '../src/test/fixtures'
import type { Context } from '../src/trpc'

const ctxFor = (t: TestDb, userId: string): Context =>
  ({
    db: t.db,
    bus: createBus(),
    user: { id: userId, email: 'x@syv.ai', name: null, avatarUrl: null },
    token: 'tok',
  }) as Context

describe('membership chokepoint', () => {
  let t: TestDb
  beforeAll(async () => {
    t = await createTestDb()
  })
  afterAll(() => t.destroy())

  it('resolveVaultRole: owner / member / non-member', async () => {
    const owner = await seedUser(t.db)
    const member = await seedUser(t.db)
    const outsider = await seedUser(t.db)
    const vault = await seedVault(t.db, owner.id)
    await addMember(t.db, vault.id, member.id)
    expect(await resolveVaultRole(t.db, vault.id, owner.id)).toBe('owner')
    expect(await resolveVaultRole(t.db, vault.id, member.id)).toBe('member')
    expect(await resolveVaultRole(t.db, vault.id, outsider.id)).toBeNull()
  })

  it('vaultProcedure rejects non-members with FORBIDDEN', async () => {
    const owner = await seedUser(t.db)
    const outsider = await seedUser(t.db)
    const vault = await seedVault(t.db, owner.id)
    const caller = vaultsRouter.createCaller(ctxFor(t, outsider.id))
    await expect(caller.get({ vaultId: vault.id })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('ownerProcedure rejects plain members', async () => {
    const owner = await seedUser(t.db)
    const member = await seedUser(t.db)
    const vault = await seedVault(t.db, owner.id)
    await addMember(t.db, vault.id, member.id)
    const caller = vaultsRouter.createCaller(ctxFor(t, member.id))
    await expect(caller.rename({ vaultId: vault.id, name: 'nope' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('membership scoping: vaults.list returns only my vaults', async () => {
    const a = await seedUser(t.db)
    const b = await seedUser(t.db)
    const mine = await seedVault(t.db, a.id, 'personal', 'mine')
    await seedVault(t.db, b.id, 'personal', 'theirs')
    const caller = vaultsRouter.createCaller(ctxFor(t, a.id))
    const list = await caller.list()
    expect(list.map((v) => v.id)).toEqual([mine.id])
  })
})
