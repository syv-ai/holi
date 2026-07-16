import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createBus } from '../src/bus'
import { reminderDeliveries, reminders, tasks } from '../src/db/schema'
import { createReminderEvaluator } from '../src/reminders/evaluator'
import { catchUpDeliveries, markDelivered } from '../src/reminders/delivery'
import { remindersRouter } from '../src/routers/reminders'
import { createTestDb, type TestDb } from '../src/test/db'
import { seedUser, seedVault } from '../src/test/fixtures'
import type { Context } from '../src/trpc'

const ctxFor = (t: TestDb, userId: string): Context =>
  ({
    db: t.db,
    bus: createBus(),
    getLiveDoc: () => null,
    user: { id: userId, email: 'x@syv.ai', name: null, avatarUrl: null },
    token: 'tok',
  }) as Context

async function seedFire(t: TestDb, vaultId: string, title: string, fireAt: Date) {
  const [task] = await t.db.insert(tasks).values({ vaultId, title }).returning()
  await t.db.insert(reminders).values({ taskId: task!.id, vaultId, fireAt, computedFrom: 'x' })
  return task!
}

const seenAt = async (t: TestDb, vaultId: string, userId: string) => {
  const [row] = await t.db
    .select()
    .from(reminderDeliveries)
    .where(eq(reminderDeliveries.userId, userId))
  return row?.seenAt ?? null
}

describe('reminder delivery (D47 — a fire nobody heard is not a fire lost)', () => {
  let t: TestDb
  let userId: string
  let vaultId: string
  let caller: ReturnType<typeof remindersRouter.createCaller>

  beforeAll(async () => {
    t = await createTestDb()
  })
  beforeEach(async () => {
    userId = (await seedUser(t.db)).id
    vaultId = (await seedVault(t.db, userId)).id
    caller = remindersRouter.createCaller(ctxFor(t, userId))
  })
  afterAll(() => t.destroy())

  // One stream now carries every vault (D50), so reconnect means EVERY vault missed
  // fires — not just the active one. The per-vault catchUp is gone with the per-vault
  // stream that was its only caller.
  describe('catchUpAll — every vault you are in, in one round trip', () => {
    it('groups the fires by vault, so a notification knows where to take you (D52)', async () => {
      const other = (await seedVault(t.db, userId, 'shared', 'second')).id
      await catchUpDeliveries(t.db, vaultId, userId) // establish both watermarks
      await catchUpDeliveries(t.db, other, userId)
      await seedFire(t, vaultId, 'in vault one', new Date(Date.now() - 1000))
      await seedFire(t, other, 'in vault two', new Date(Date.now() - 1000))
      await createReminderEvaluator({ db: t.db, bus: createBus() }).tick()

      const all = await caller.catchUpAll()

      const byVault = new Map(all.map((r) => [r.vaultId, r.event]))
      expect(byVault.get(vaultId)?.fires[0]?.title).toBe('in vault one')
      expect(byVault.get(other)?.fires[0]?.title).toBe('in vault two')
    })

    // A flat concat would have thrown away the only thing that could make the
    // notification clickable — the vault the task lives in.
    it('omits a vault with nothing missed rather than returning a null entry', async () => {
      const quiet = (await seedVault(t.db, userId, 'shared', 'quiet')).id
      await catchUpDeliveries(t.db, vaultId, userId)
      await catchUpDeliveries(t.db, quiet, userId)
      await seedFire(t, vaultId, 'only here', new Date(Date.now() - 1000))
      await createReminderEvaluator({ db: t.db, bus: createBus() }).tick()

      const all = await caller.catchUpAll()

      expect(all.map((r) => r.vaultId)).toEqual([vaultId])
    })

    it('never reaches into a vault you are not in', async () => {
      const stranger = await seedUser(t.db)
      const theirs = (await seedVault(t.db, stranger.id)).id
      await catchUpDeliveries(t.db, theirs, stranger.id)
      await seedFire(t, theirs, 'not yours', new Date(Date.now() - 1000))
      await createReminderEvaluator({ db: t.db, bus: createBus() }).tick()

      const all = await caller.catchUpAll()

      expect(all.map((r) => r.vaultId)).not.toContain(theirs)
    })
  })

  // A brand-new member must not be buried under every reminder the vault ever fired.
  it('a first-ever connect gets no backlog, and starts the watermark', async () => {
    await seedFire(t, vaultId, 'fired before I ever connected', new Date(Date.now() - 60_000))
    await createReminderEvaluator({ db: t.db, bus: createBus() }).tick()

    expect(await catchUpDeliveries(t.db, vaultId, userId)).toBeNull()
    expect(await seenAt(t, vaultId, userId)).not.toBeNull()
  })

  // The bug this whole slice exists for: the app was closed when it fired.
  it('replays a fire that happened while nobody was listening', async () => {
    await catchUpDeliveries(t.db, vaultId, userId) // establish the watermark, as a first connect does
    const task = await seedFire(t, vaultId, 'fired while you were away', new Date(Date.now() - 1000))
    await createReminderEvaluator({ db: t.db, bus: createBus() }).tick()

    const event = await catchUpDeliveries(t.db, vaultId, userId)

    expect(event?.fires).toHaveLength(1)
    expect(event?.fires[0]).toMatchObject({ taskId: task.id, title: 'fired while you were away' })
  })

  it('is idempotent — a second catch-up replays nothing', async () => {
    await catchUpDeliveries(t.db, vaultId, userId)
    await seedFire(t, vaultId, 'once', new Date(Date.now() - 1000))
    await createReminderEvaluator({ db: t.db, bus: createBus() }).tick()

    expect((await catchUpDeliveries(t.db, vaultId, userId))?.fires).toHaveLength(1)
    expect(await catchUpDeliveries(t.db, vaultId, userId)).toBeNull()
  })

  // Live delivery advances the watermark, so reconnecting doesn't re-notify.
  it('does not replay a fire already delivered live', async () => {
    await catchUpDeliveries(t.db, vaultId, userId)
    await seedFire(t, vaultId, 'you saw this live', new Date(Date.now() - 1000))
    const bus = createBus()
    const seen: string[] = []
    bus.on(`reminders:${vaultId}`, (e) => seen.push(e.firedAt))
    await createReminderEvaluator({ db: t.db, bus }).tick()

    // what events.ts does after sending the frame to this user
    await markDelivered(t.db, vaultId, userId, seen[0]!)

    expect(await catchUpDeliveries(t.db, vaultId, userId)).toBeNull()
  })

  // A re-armed reminder's old fire is moot — the task moved past it.
  it('drops a superseded fire when the reminder re-arms', async () => {
    await catchUpDeliveries(t.db, vaultId, userId)
    const task = await seedFire(t, vaultId, 'superseded', new Date(Date.now() - 1000))
    await createReminderEvaluator({ db: t.db, bus: createBus() }).tick()

    // recomputeReminder's upsert on a task edit: new fireAt, fire cleared
    await t.db
      .update(reminders)
      .set({ fireAt: new Date(Date.now() + 3_600_000), firedAt: null })
      .where(eq(reminders.taskId, task.id))

    expect(await catchUpDeliveries(t.db, vaultId, userId)).toBeNull()
  })

  it('coalesces a large backlog into one summary event', async () => {
    await catchUpDeliveries(t.db, vaultId, userId)
    for (let i = 0; i < 6; i++) await seedFire(t, vaultId, `r${i}`, new Date(Date.now() - 1000))
    await createReminderEvaluator({ db: t.db, bus: createBus() }).tick()

    const event = await catchUpDeliveries(t.db, vaultId, userId)

    expect(event?.fires).toHaveLength(6)
    expect(event?.coalesced).toBe(true)
  })

  // The watermark only ever moves forward — an out-of-order advance must not rewind it
  // and re-notify everything since.
  it('never rewinds the watermark', async () => {
    await catchUpDeliveries(t.db, vaultId, userId)
    const before = await seenAt(t, vaultId, userId)

    await markDelivered(t.db, vaultId, userId, new Date(Date.now() - 3_600_000).toISOString())

    expect((await seenAt(t, vaultId, userId))?.getTime()).toBe(before?.getTime())
  })

  // Delivery is per-member: a fire concerns everyone in the vault (Task has no assignee).
  it('tracks each member separately', async () => {
    const other = await seedUser(t.db)
    await t.db.insert(
      // add the second member directly — membership fixtures are covered elsewhere
      (await import('../src/db/schema')).memberships,
    ).values({ vaultId, userId: other.id, role: 'member' })
    await catchUpDeliveries(t.db, vaultId, userId)
    await catchUpDeliveries(t.db, vaultId, other.id)

    await seedFire(t, vaultId, 'concerns us both', new Date(Date.now() - 1000))
    await createReminderEvaluator({ db: t.db, bus: createBus() }).tick()

    // one member reading their fires must not consume the other's
    expect((await catchUpDeliveries(t.db, vaultId, userId))?.fires).toHaveLength(1)
    expect((await catchUpDeliveries(t.db, vaultId, other.id))?.fires).toHaveLength(1)
  })
})
