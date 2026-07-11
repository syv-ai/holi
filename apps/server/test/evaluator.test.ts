import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBus, type RemindersEvent } from '../src/bus'
import { reminders, tasks } from '../src/db/schema'
import { createReminderEvaluator } from '../src/reminders/evaluator'
import { createTestDb, type TestDb } from '../src/test/db'
import { seedUser, seedVault } from '../src/test/fixtures'

async function seedFire(t: TestDb, vaultId: string, title: string, fireAt: Date) {
  const [task] = await t.db.insert(tasks).values({ vaultId, title }).returning()
  await t.db.insert(reminders).values({ taskId: task!.id, vaultId, fireAt, computedFrom: 'x' })
  return task!
}

describe('reminder evaluator', () => {
  let t: TestDb
  let vaultId: string
  beforeAll(async () => {
    t = await createTestDb()
    const u = await seedUser(t.db)
    vaultId = (await seedVault(t.db, u.id)).id
  })
  afterAll(() => t.destroy())

  it('tick fires due reminders: marks fired, writes reminded_at, pushes per-vault', async () => {
    const bus = createBus()
    const events: RemindersEvent[] = []
    bus.on(`reminders:${vaultId}`, (e) => events.push(e))
    const task = await seedFire(t, vaultId, 'due now', new Date(Date.now() - 1000))
    const future = await seedFire(t, vaultId, 'later', new Date(Date.now() + 3_600_000))

    const evaluator = createReminderEvaluator({ db: t.db, bus })
    await evaluator.tick()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ coalesced: false, fires: [expect.objectContaining({ taskId: task.id })] })
    const [firedRow] = await t.db.select().from(reminders).where(eq(reminders.taskId, task.id))
    expect(firedRow?.fired).toBe(true)
    const [taskRow] = await t.db.select().from(tasks).where(eq(tasks.id, task.id))
    expect(taskRow?.remindedAt).not.toBeNull()
    const [futureRow] = await t.db.select().from(reminders).where(eq(reminders.taskId, future.id))
    expect(futureRow?.fired).toBe(false)

    // second tick: nothing new fires
    await evaluator.tick()
    expect(events).toHaveLength(1)
  })

  it('boot backlog >5 in one vault coalesces into a single summary event', async () => {
    const u = await seedUser(t.db)
    const backlogVault = (await seedVault(t.db, u.id)).id
    const bus = createBus()
    const events: RemindersEvent[] = []
    bus.on(`reminders:${backlogVault}`, (e) => events.push(e))
    for (let i = 0; i < 7; i++) await seedFire(t, backlogVault, `missed ${i}`, new Date(Date.now() - 60_000))

    await createReminderEvaluator({ db: t.db, bus }).tick()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ coalesced: true })
    expect(events[0]?.fires).toHaveLength(7)
  })
})
