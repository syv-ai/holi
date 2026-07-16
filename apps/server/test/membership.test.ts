import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createBus } from '../src/bus'
import { config } from '../src/config'
import { membershipRouter } from '../src/routers/membership'
import { createTestDb, type TestDb } from '../src/test/db'
import { addMember, seedUser, seedVault } from '../src/test/fixtures'
import type { Context } from '../src/trpc'

const ctxFor = (t: TestDb, userId: string): Context =>
  ({
    db: t.db,
    bus: createBus(),
    getLiveDoc: () => null,
    user: { id: userId, email: 'x@syv.ai', name: null, avatarUrl: null },
    token: 'tok',
  }) as Context

describe('membership', () => {
  let t: TestDb
  let ownerId: string
  let caller: ReturnType<typeof membershipRouter.createCaller>

  beforeAll(async () => {
    t = await createTestDb()
  })
  beforeEach(async () => {
    ownerId = (await seedUser(t.db)).id
    caller = membershipRouter.createCaller(ctxFor(t, ownerId))
  })
  afterAll(() => t.destroy())

  // D49. A personal vault gaining a second member breaks daily notes' "one owner,
  // therefore one clock" (D44/D45) — "today" stops having a single answer.
  describe('a personal vault cannot be shared (D49, auth-identity FR-14)', () => {
    let personalId: string
    let other: { id: string }
    beforeEach(async () => {
      personalId = (await seedVault(t.db, ownerId, 'personal', 'mine')).id
      other = await seedUser(t.db)
    })

    it('rejects invite', async () => {
      await expect(
        caller.invite({ vaultId: personalId, email: 'someone@syv.ai', role: 'member' }),
      ).rejects.toThrow(/personal vault/i)
    })

    it('rejects transferOwnership — you cannot hand your personal vault away', async () => {
      await expect(
        caller.transferOwnership({ vaultId: personalId, toUserId: other.id }),
      ).rejects.toThrow(/personal vault/i)
    })

    // These were blocked only incidentally, by assertNotLastOwner / the owner check.
    // Now they are blocked on purpose, and say why.
    it('rejects leave', async () => {
      await expect(caller.leave({ vaultId: personalId })).rejects.toThrow(/personal vault/i)
    })

    it('rejects setRole', async () => {
      await expect(
        caller.setRole({ vaultId: personalId, userId: ownerId, role: 'member' }),
      ).rejects.toThrow(/personal vault/i)
    })

    it('rejects remove', async () => {
      await expect(caller.remove({ vaultId: personalId, userId: ownerId })).rejects.toThrow(
        /personal vault/i,
      )
    })

    // FR-14 disables invite/leave/transfer — not reading your own single membership.
    it('still lists its single member', async () => {
      const members = await caller.list({ vaultId: personalId })
      expect(members).toEqual([expect.objectContaining({ userId: ownerId, role: 'owner' })])
    })
  })

  describe('invite is domain-restricted (FR-10)', () => {
    let vaultId: string
    const original = config.google.workspaceDomain
    beforeEach(async () => {
      vaultId = (await seedVault(t.db, ownerId, 'shared')).id
      config.google.workspaceDomain = 'syv.ai'
    })
    afterEach(() => void (config.google.workspaceDomain = original))

    it('rejects an email outside the workspace domain', async () => {
      await expect(
        caller.invite({ vaultId, email: 'outsider@gmail.com', role: 'member' }),
      ).rejects.toThrow(/syv\.ai/)
    })

    it('accepts an email inside it', async () => {
      const { userId } = await caller.invite({ vaultId, email: 'teammate@syv.ai', role: 'member' })
      expect(userId).toBeTruthy()
    })

    it('is case-insensitive about the domain', async () => {
      const { userId } = await caller.invite({ vaultId, email: 'Teammate@SYV.ai', role: 'member' })
      expect(userId).toBeTruthy()
    })

    // Unset ⇒ no restriction, exactly as assertWorkspace behaves. Hardcoding the domain
    // would break every dev environment, where the var is unset by design.
    it('allows any domain when no workspace domain is configured', async () => {
      config.google.workspaceDomain = undefined
      const { userId } = await caller.invite({ vaultId, email: 'anyone@example.com', role: 'member' })
      expect(userId).toBeTruthy()
    })
  })

  describe('the rules that must survive the move to a service', () => {
    let vaultId: string
    beforeEach(async () => {
      vaultId = (await seedVault(t.db, ownerId, 'shared')).id
    })

    it('invite mints a stub user, claimed on first sign-in', async () => {
      const { userId } = await caller.invite({ vaultId, email: 'invitee@syv.ai', role: 'member' })
      const members = await caller.list({ vaultId })
      expect(members.map((m) => m.userId)).toContain(userId)
    })

    it('a second invite of the same person is a no-op, not a duplicate', async () => {
      await caller.invite({ vaultId, email: 'invitee@syv.ai', role: 'member' })
      await caller.invite({ vaultId, email: 'invitee@syv.ai', role: 'member' })
      const members = await caller.list({ vaultId })
      expect(members.filter((m) => m.email === 'invitee@syv.ai')).toHaveLength(1)
    })

    it('the last owner cannot be removed or demoted', async () => {
      await expect(caller.remove({ vaultId, userId: ownerId })).rejects.toThrow(/last owner/)
      await expect(
        caller.setRole({ vaultId, userId: ownerId, role: 'member' }),
      ).rejects.toThrow(/last owner/)
    })

    it('an owner must transfer before leaving; a member may just leave', async () => {
      const member = await seedUser(t.db)
      await addMember(t.db, vaultId, member.id)
      await expect(caller.leave({ vaultId })).rejects.toThrow(/transfer ownership/)

      await membershipRouter.createCaller(ctxFor(t, member.id)).leave({ vaultId })
      expect((await caller.list({ vaultId })).map((m) => m.userId)).not.toContain(member.id)
    })

    it('transferOwnership swaps both roles and the vault owner', async () => {
      const member = await seedUser(t.db)
      await addMember(t.db, vaultId, member.id)

      await caller.transferOwnership({ vaultId, toUserId: member.id })

      const members = await caller.list({ vaultId })
      expect(members.find((m) => m.userId === member.id)?.role).toBe('owner')
      expect(members.find((m) => m.userId === ownerId)?.role).toBe('member')
    })

    it('a non-owner cannot invite', async () => {
      const member = await seedUser(t.db)
      await addMember(t.db, vaultId, member.id)
      await expect(
        membershipRouter.createCaller(ctxFor(t, member.id)).invite({
          vaultId,
          email: 'nope@syv.ai',
          role: 'member',
        }),
      ).rejects.toThrow(/owner/)
    })
  })
})
