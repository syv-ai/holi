import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBus } from '../src/bus'
import { folders, reminders, tasks } from '../src/db/schema'
import { tasksRouter } from '../src/routers/tasks'
import { createTestDb, type TestDb } from '../src/test/db'
import { seedUser, seedVault } from '../src/test/fixtures'
import type { Context } from '../src/trpc'
import { localToUtc } from '../src/reminders/tz'

const ctxFor = (t: TestDb, userId: string): Context =>
  ({
    db: t.db,
    bus: createBus(),
    getLiveDoc: () => null,
    user: { id: userId, email: 'x@syv.ai', name: null, avatarUrl: null },
    token: 'tok',
  }) as Context

describe('tasks', () => {
  let t: TestDb
  let userId: string
  let vaultId: string
  beforeAll(async () => {
    t = await createTestDb()
    const u = await seedUser(t.db)
    userId = u.id
    vaultId = (await seedVault(t.db, u.id)).id
  })
  afterAll(() => t.destroy())

  it('create with a relative reminder materializes a reminders row (due-1d @ 09:00 local)', async () => {
    const caller = tasksRouter.createCaller(ctxFor(t, userId))
    const task = await caller.create({ vaultId, title: 'ship it', due: '2030-06-14', reminder: '1d' })
    const [row] = await t.db.select().from(reminders).where(eq(reminders.taskId, task.id))
    expect(row?.fireAt.toISOString()).toBe(
      localToUtc('2030-06-13T09:00', 'Europe/Copenhagen').toISOString(),
    )
    expect(row?.computedFrom).toBe('1d')
  })

  it('invalid reminders are inert — no row, no error (ported semantic)', async () => {
    const caller = tasksRouter.createCaller(ctxFor(t, userId))
    const task = await caller.create({ vaultId, title: 'x', reminder: 'gibberish' })
    expect(await t.db.select().from(reminders).where(eq(reminders.taskId, task.id))).toHaveLength(0)
  })

  it('update recomputes; completing a non-recurring task clears the projection', async () => {
    const caller = tasksRouter.createCaller(ctxFor(t, userId))
    const task = await caller.create({ vaultId, title: 'y', due: '2030-01-10', reminder: '2w' })
    await caller.update({ vaultId, taskId: task.id, patch: { due: '2030-02-10' } })
    const [row] = await t.db.select().from(reminders).where(eq(reminders.taskId, task.id))
    expect(row?.fireAt.toISOString()).toBe(
      localToUtc('2030-01-27T09:00', 'Europe/Copenhagen').toISOString(),
    )
    await caller.complete({ vaultId, taskId: task.id })
    const [done] = await t.db.select().from(tasks).where(eq(tasks.id, task.id))
    expect(done?.status).toBe('done')
    expect(done?.completedAt).not.toBeNull()
    expect(await t.db.select().from(reminders).where(eq(reminders.taskId, task.id))).toHaveLength(0)
  })

  it('complete on a recurring task rolls forward server-side (D19): due advances past today, status back to todo, absolute reminder shifts, reminded_at clears', async () => {
    const caller = tasksRouter.createCaller(ctxFor(t, userId))
    const task = await caller.create({
      vaultId,
      title: 'weekly sync',
      due: '2020-01-06', // decades stale — exercises nextDueCatchup
      reminder: '2020-01-05T15:00',
      recurrence: { frequency: 'weekly', interval: 1 },
    })
    await t.db.update(tasks).set({ remindedAt: new Date() }).where(eq(tasks.id, task.id))
    const rolled = await caller.complete({ vaultId, taskId: task.id })
    expect(rolled.status).toBe('todo')
    expect(rolled.due! >= new Date().toISOString().slice(0, 10)).toBe(true)
    // absolute reminder shifted by the same day-delta (still a T15:00 datetime)
    expect(rolled.reminder).toMatch(/T15:00$/)
    const [row] = await t.db.select().from(tasks).where(eq(tasks.id, task.id))
    expect(row?.remindedAt).toBeNull()
    expect(await t.db.select().from(reminders).where(eq(reminders.taskId, task.id))).toHaveLength(1)
  })

  it('link/unlink mutate the unified related[] by stable id', async () => {
    const caller = tasksRouter.createCaller(ctxFor(t, userId))
    const task = await caller.create({ vaultId, title: 'z' })
    const ref = { kind: 'note' as const, id: '4dbb1757-0000-4000-8000-000000000000' }
    await caller.link({ vaultId, taskId: task.id, related: ref })
    expect((await caller.get({ vaultId, taskId: task.id })).related).toEqual([ref])
    await caller.unlink({ vaultId, taskId: task.id, related: ref })
    expect((await caller.get({ vaultId, taskId: task.id })).related).toEqual([])
  })

  it('every mutation bumps version — the token the task file round-trips', async () => {
    const ctx = ctxFor(t, userId)
    const events: Array<{ type: string; task?: { version: number } }> = []
    ctx.bus.on(`tasks:${vaultId}`, (e) => events.push(e))
    const caller = tasksRouter.createCaller(ctx)

    const created = await caller.create({ vaultId, title: 'versioned', description: 'the body' })
    expect(created.version).toBe(1)
    expect(created.description).toBe('the body')

    const once = await caller.update({ vaultId, taskId: created.id, patch: { title: 'v2' } })
    expect(once.version).toBe(2)

    const twice = await caller.update({ vaultId, taskId: created.id, patch: { priority: 'high' } })
    expect(twice.version).toBe(3)

    // link/unlink and complete are mutations too — a path that forgot to bump
    // would let a stale file write win.
    const linked = await caller.link({
      vaultId,
      taskId: created.id,
      related: { kind: 'task', id: created.id },
    })
    expect(linked.version).toBe(4)
    const completed = await caller.complete({ vaultId, taskId: created.id })
    expect(completed.version).toBe(5)

    // the bumped version rides the push, so the projector rewrites with it
    expect(events.at(-1)).toMatchObject({ type: 'upserted', task: { version: 5 } })
  })

  it('a stale version loses — CONFLICT, and the record is left untouched', async () => {
    const caller = tasksRouter.createCaller(ctxFor(t, userId))
    const task = await caller.create({ vaultId, title: 'contested' })

    // someone else moves the record on (a board drag, a teammate, a reminder fire)
    await caller.update({ vaultId, taskId: task.id, patch: { status: 'doing' } })

    // the file writer is still holding version 1
    await expect(
      caller.update({
        vaultId,
        taskId: task.id,
        patch: { title: 'written from a stale file' },
        version: task.version,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    // a partial apply here is the bug that silently diverges disk from truth
    const fresh = await caller.get({ vaultId, taskId: task.id })
    expect(fresh.title).toBe('contested')
    expect(fresh.status).toBe('doing')
    expect(fresh.version).toBe(2)
  })

  it('a current version wins, and the board (which sends none) is unaffected', async () => {
    const caller = tasksRouter.createCaller(ctxFor(t, userId))
    const task = await caller.create({ vaultId, title: 'fresh' })

    const ok = await caller.update({
      vaultId,
      taskId: task.id,
      patch: { title: 'written from a current file' },
      version: task.version,
    })
    expect(ok.title).toBe('written from a current file')

    // no version = plain last-writer-wins, the board's existing behavior
    const boardWrite = await caller.update({ vaultId, taskId: task.id, patch: { priority: 'low' } })
    expect(boardWrite.priority).toBe('low')
  })

  it('the guard covers complete and delete too, not just update', async () => {
    const caller = tasksRouter.createCaller(ctxFor(t, userId))
    const task = await caller.create({ vaultId, title: 'guarded' })
    await caller.update({ vaultId, taskId: task.id, patch: { status: 'doing' } })

    await expect(
      caller.complete({ vaultId, taskId: task.id, version: task.version }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      caller.delete({ vaultId, taskId: task.id, version: task.version }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    // still there, still not done
    expect((await caller.get({ vaultId, taskId: task.id })).status).toBe('doing')
  })

  it('watch: mutations emit tasks events on the vault channel', async () => {
    const ctx = ctxFor(t, userId)
    const events: unknown[] = []
    ctx.bus.on(`tasks:${vaultId}`, (e) => events.push(e))
    const caller = tasksRouter.createCaller(ctx)
    const task = await caller.create({ vaultId, title: 'live' })
    await caller.delete({ vaultId, taskId: task.id })
    expect(events).toEqual([
      expect.objectContaining({ type: 'upserted' }),
      expect.objectContaining({ type: 'deleted', taskId: task.id }),
    ])
  })
  /** A task outlives its folder. The un-cascaded FK this replaces made Postgres REFUSE
   * to delete any folder a task pointed at — a policy nobody chose, which silently made
   * folders undeletable and contradicted the PRD's promise that the task isn't lost.
   * An unfiled task is a first-class state: that is what the "(no area)" lane is. */
  it('deleting a folder unfiles its tasks — it does not fail, and it does not lose them', async () => {
    const caller = tasksRouter.createCaller(ctxFor(t, userId))
    const [f] = await t.db.insert(folders).values({ vaultId, path: 'projects/doomed' }).returning()
    const task = await caller.create({ vaultId, title: 'Filed under a doomed folder', area: f!.id })
    expect(task.area).toBe(f!.id)

    await t.db.delete(folders).where(eq(folders.id, f!.id)) // must not throw

    const [row] = await t.db.select().from(tasks).where(eq(tasks.id, task.id))
    expect(row).toBeDefined()      // the task survived its folder
    expect(row!.area).toBeNull()   // and fell into "(no area)"
    expect(row!.title).toBe('Filed under a doomed folder')
  })
})
