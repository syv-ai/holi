import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBus } from '../src/bus'
import { membershipRouter } from '../src/routers/membership'
import { vaultsRouter } from '../src/routers/vaults'
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

describe('vaults + membership', () => {
  let t: TestDb
  beforeAll(async () => {
    t = await createTestDb()
  })
  afterAll(() => t.destroy())

  it('create makes vault + owner membership atomically', async () => {
    const u = await seedUser(t.db)
    const vault = await vaultsRouter.createCaller(ctxFor(t, u.id)).create({ name: 'team', kind: 'shared' })
    const members = await membershipRouter.createCaller(ctxFor(t, u.id)).list({ vaultId: vault.id })
    expect(members).toEqual([expect.objectContaining({ userId: u.id, role: 'owner' })])
  })

  it('invite creates a stub user and a membership', async () => {
    const owner = await seedUser(t.db)
    const vault = await seedVault(t.db, owner.id)
    const caller = membershipRouter.createCaller(ctxFor(t, owner.id))
    const { userId } = await caller.invite({ vaultId: vault.id, email: 'invitee@syv.ai', role: 'member' })
    const members = await caller.list({ vaultId: vault.id })
    expect(members.map((m) => m.userId)).toContain(userId)
  })

  it('owner cannot leave; last owner cannot be removed or demoted', async () => {
    const owner = await seedUser(t.db)
    const vault = await seedVault(t.db, owner.id)
    const caller = membershipRouter.createCaller(ctxFor(t, owner.id))
    await expect(caller.leave({ vaultId: vault.id })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(caller.remove({ vaultId: vault.id, userId: owner.id })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    await expect(
      caller.setRole({ vaultId: vault.id, userId: owner.id, role: 'member' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('transferOwnership swaps roles and vault.ownerId', async () => {
    const a = await seedUser(t.db)
    const b = await seedUser(t.db)
    const vault = await seedVault(t.db, a.id)
    await addMember(t.db, vault.id, b.id)
    await membershipRouter.createCaller(ctxFor(t, a.id)).transferOwnership({ vaultId: vault.id, toUserId: b.id })
    const fresh = await vaultsRouter.createCaller(ctxFor(t, b.id)).get({ vaultId: vault.id })
    expect(fresh.ownerId).toBe(b.id)
    // old owner is now a plain member: owner-gated call fails
    await expect(
      vaultsRouter.createCaller(ctxFor(t, a.id)).rename({ vaultId: vault.id, name: 'x' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
