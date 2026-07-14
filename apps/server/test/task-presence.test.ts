/** Presence: "Nicolai is editing this task" (prd/tasks.md §Concurrency: presence, not
 * locks). A heartbeat, not a lock — nothing is acquired, nothing is stored, and a
 * heartbeat that stops arriving IS the release. */
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createBus, type Bus, type PresenceEvent, type TasksEvent } from '../src/bus'
import { tasks } from '../src/db/schema'
import { tasksRouter } from '../src/routers/tasks'
import { createTestDb, type TestDb } from '../src/test/db'
import { seedUser, seedVault } from '../src/test/fixtures'
import type { Context } from '../src/trpc'

let t: TestDb
let userId: string
let vaultId: string
let bus: Bus

const ctx = (): Context =>
  ({
    db: t.db,
    bus,
    getLiveDoc: () => null,
    user: { id: userId, email: 'nicolai@syv.ai', name: 'Nicolai', avatarUrl: null },
    token: 'tok',
  }) as Context

const caller = () => tasksRouter.createCaller(ctx())

beforeAll(async () => {
  t = await createTestDb()
  const u = await seedUser(t.db)
  userId = u.id
  vaultId = (await seedVault(t.db, u.id)).id
})
afterAll(() => t.destroy())

beforeEach(() => {
  bus = createBus()
})

describe('tasks.heartbeat', () => {
  it('emits presence on the vault channel, naming the actor', async () => {
    const seen: PresenceEvent[] = []
    bus.on(`presence:${vaultId}`, (e: PresenceEvent) => seen.push(e))
    const task = await caller().create({ vaultId, title: 'Shared task' })

    await caller().heartbeat({ vaultId, taskId: task.id })

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ taskId: task.id, userId, name: 'Nicolai' })
    expect(Date.parse(seen[0]!.expiresAt)).toBeGreaterThan(Date.now())
  })

  /** The heartbeat must touch no row. If it bumped `version` it would rewrite every
   * task file it touched — and with the git mirror on, the bot would COMMIT a file
   * change for every keystroke someone made in the board's task editor. */
  it('touches no row: no version bump, no updatedAt change, no tasks event', async () => {
    const task = await caller().create({ vaultId, title: 'Untouched' })
    const [before] = await t.db.select().from(tasks).where(eq(tasks.id, task.id))

    const tasksEvents: TasksEvent[] = []
    bus.on(`tasks:${vaultId}`, (e: TasksEvent) => tasksEvents.push(e))

    await caller().heartbeat({ vaultId, taskId: task.id })
    await caller().heartbeat({ vaultId, taskId: task.id })
    await caller().heartbeat({ vaultId, taskId: task.id })

    const [after] = await t.db.select().from(tasks).where(eq(tasks.id, task.id))
    expect(after!.version).toBe(before!.version)
    expect(after!.updatedAt).toEqual(before!.updatedAt)
    expect(tasksEvents).toEqual([]) // presence is NOT a task change
  })

  /** Expiry is the entire lifecycle. There is no release call to lose, no stale lock
   * from a crashed holder, and no steal path — which is why this is a heartbeat and
   * not a lock. */
  it('carries a short expiry that the client uses to drop it', async () => {
    const seen: PresenceEvent[] = []
    bus.on(`presence:${vaultId}`, (e: PresenceEvent) => seen.push(e))
    const task = await caller().create({ vaultId, title: 'Expiring' })

    await caller().heartbeat({ vaultId, taskId: task.id })

    const ttl = Date.parse(seen[0]!.expiresAt) - Date.now()
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(10_000)
  })
})
