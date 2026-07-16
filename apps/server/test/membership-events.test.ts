/**
 * The funnel (D51): every writer of the `memberships` table announces itself on
 * `user:<id>`, and nothing else does. A direct `insert into memberships` fires no event,
 * so a live user-scoped stream never re-keys and the invitee's switcher stays empty until
 * restart — which is exactly the bug this exists to kill. These tests are per *writer*,
 * not per router, because the writers span three modules.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createBus, type Bus, type MembershipEvent } from '../src/bus'
import { provisionPersonalVault } from '../src/auth/provision'
import { insertMembershipRow } from '../src/membership/service'
import { membershipRouter } from '../src/routers/membership'
import { vaultsRouter } from '../src/routers/vaults'
import { createTestDb, type TestDb } from '../src/test/db'
import { seedUser, seedVault } from '../src/test/fixtures'
import type { Context } from '../src/trpc'

const ctxFor = (t: TestDb, bus: Bus, userId: string): Context =>
  ({
    db: t.db,
    bus,
    getLiveDoc: () => null,
    user: { id: userId, email: 'x@syv.ai', name: null, avatarUrl: null },
    token: 'tok',
  }) as Context

/** Collect what a given user is told. */
function watch(bus: Bus, userId: string): MembershipEvent[] {
  const seen: MembershipEvent[] = []
  bus.on(`user:${userId}`, (e: MembershipEvent) => seen.push(e))
  return seen
}

describe('a membership change announces itself on user:<id> (D51)', () => {
  let t: TestDb
  let bus: Bus
  let ownerId: string
  let vaultId: string

  beforeAll(async () => {
    t = await createTestDb()
  })
  afterAll(() => t.destroy())
  beforeEach(async () => {
    bus = createBus()
    ownerId = (await seedUser(t.db)).id
    vaultId = (await seedVault(t.db, ownerId)).id
  })

  it('invite tells the invited user they joined — not the owner who invited them', async () => {
    const invitee = await seedUser(t.db, 'invitee@syv.ai')
    const theirs = watch(bus, invitee.id)
    const owners = watch(bus, ownerId)
    await membershipRouter
      .createCaller(ctxFor(t, bus, ownerId))
      .invite({ vaultId, email: 'invitee@syv.ai', role: 'member' })
    expect(theirs).toEqual([{ type: 'joined' }])
    expect(owners).toEqual([])
  })

  it('re-inviting an existing member emits nothing — the frame must not lie', async () => {
    const invitee = await seedUser(t.db, 'twice@syv.ai')
    const caller = membershipRouter.createCaller(ctxFor(t, bus, ownerId))
    await caller.invite({ vaultId, email: 'twice@syv.ai', role: 'member' })
    const seen = watch(bus, invitee.id) // watch only the SECOND invite
    await caller.invite({ vaultId, email: 'twice@syv.ai', role: 'member' })
    expect(seen).toEqual([])
  })

  it('remove tells the removed user they left', async () => {
    const member = await seedUser(t.db, 'gone@syv.ai')
    const owner = membershipRouter.createCaller(ctxFor(t, bus, ownerId))
    await owner.invite({ vaultId, email: 'gone@syv.ai', role: 'member' })
    const seen = watch(bus, member.id)
    await owner.remove({ vaultId, userId: member.id })
    expect(seen).toEqual([{ type: 'left' }])
  })

  it('leave tells the leaving user they left', async () => {
    const member = await seedUser(t.db, 'bye@syv.ai')
    await membershipRouter
      .createCaller(ctxFor(t, bus, ownerId))
      .invite({ vaultId, email: 'bye@syv.ai', role: 'member' })
    const seen = watch(bus, member.id)
    await membershipRouter.createCaller(ctxFor(t, bus, member.id)).leave({ vaultId })
    expect(seen).toEqual([{ type: 'left' }])
  })

  it('vaults.create tells the creator they joined the vault they just made', async () => {
    const seen = watch(bus, ownerId)
    await vaultsRouter.createCaller(ctxFor(t, bus, ownerId)).create({ name: 'fresh', kind: 'shared' })
    expect(seen).toEqual([{ type: 'joined' }])
  })

  it('provisioning a personal vault announces it', async () => {
    const fresh = await seedUser(t.db)
    const seen = watch(bus, fresh.id)
    await provisionPersonalVault(t.db, bus, fresh.id)
    expect(seen).toEqual([{ type: 'joined' }])
  })

  it('provisioning twice announces once — the second call is a no-op, not a re-join', async () => {
    const fresh = await seedUser(t.db)
    await provisionPersonalVault(t.db, bus, fresh.id)
    const seen = watch(bus, fresh.id) // watch only the SECOND call
    await provisionPersonalVault(t.db, bus, fresh.id)
    expect(seen).toEqual([])
  })

  describe('a role change is not a join or a leave', () => {
    it('setRole emits nothing', async () => {
      const member = await seedUser(t.db, 'role@syv.ai')
      const owner = membershipRouter.createCaller(ctxFor(t, bus, ownerId))
      await owner.invite({ vaultId, email: 'role@syv.ai', role: 'member' })
      const theirs = watch(bus, member.id)
      const owners = watch(bus, ownerId)
      await owner.setRole({ vaultId, userId: member.id, role: 'owner' })
      expect([...theirs, ...owners]).toEqual([])
    })

    it('transferOwnership emits nothing — both parties are still members', async () => {
      const member = await seedUser(t.db, 'heir@syv.ai')
      const owner = membershipRouter.createCaller(ctxFor(t, bus, ownerId))
      await owner.invite({ vaultId, email: 'heir@syv.ai', role: 'member' })
      const theirs = watch(bus, member.id)
      const owners = watch(bus, ownerId)
      await owner.transferOwnership({ vaultId, toUserId: member.id })
      expect([...theirs, ...owners]).toEqual([])
    })
  })

  // NOTE — "the emit lands after the tx commits" is NOT tested here, deliberately.
  // It is enforced *structurally*: `insertMembershipRow` takes no `Bus`, so nothing
  // inside a transaction has one to emit with, and every caller emits after
  // `await db.transaction(...)` — which resolves only on commit.
  //
  // It is not tested because it is not honestly testable. No transaction in this
  // codebase can roll back *after* the membership insert lands (it is the last statement
  // in every one), and a test that emits mid-tx and races a listener's read against the
  // commit passes either way — verified by mutation: moving the emit inside
  // `inviteMember`'s tx did not fail a single test. A test that cannot fail is worse than
  // no test, so the guard is the missing `Bus` parameter and the comment on it, not this.
  it('a rolled-back transaction writes no row', async () => {
    const fresh = await seedUser(t.db)
    await expect(
      t.db.transaction(async (tx) => {
        await insertMembershipRow(tx, { vaultId, userId: fresh.id, role: 'member' })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    const members = await membershipRouter.createCaller(ctxFor(t, bus, ownerId)).list({ vaultId })
    expect(members.map((m) => m.userId)).not.toContain(fresh.id)
  })
})
