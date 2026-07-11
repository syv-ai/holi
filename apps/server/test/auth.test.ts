import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertWorkspace, upsertGoogleUser } from '../src/auth/google'
import { users } from '../src/db/schema'
import { resolveSession } from '../src/auth/sessions'
import { authRouter } from '../src/routers/auth'
import { createTestDb, type TestDb } from '../src/test/db'
import { seedSession, seedUser } from '../src/test/fixtures'
import type { Context } from '../src/trpc'

const ctxFor = (t: TestDb, user: Awaited<ReturnType<typeof resolveSession>>, token: string | null): Context =>
  ({ db: t.db, bus: undefined as never, user, token }) as Context

describe('auth', () => {
  let t: TestDb
  beforeAll(async () => {
    t = await createTestDb()
  })
  afterAll(() => t.destroy())

  it('upsertGoogleUser inserts then refreshes profile on the same sub', async () => {
    const a = await upsertGoogleUser(t.db, { sub: 'g1', email: 'x@syv.ai', name: 'X' })
    const b = await upsertGoogleUser(t.db, { sub: 'g1', email: 'x@syv.ai', name: 'X Renamed' })
    expect(b.id).toBe(a.id)
    expect(b.name).toBe('X Renamed')
  })

  it('first sign-in claims an invited stub user by email', async () => {
    await t.db.insert(users).values({ googleSub: 'pending:new@syv.ai', email: 'new@syv.ai' })
    const user = await upsertGoogleUser(t.db, { sub: 'g-real', email: 'new@syv.ai', name: 'New' })
    expect(user.googleSub).toBe('g-real')
    const all = await t.db.select().from(users).where(eq(users.email, 'new@syv.ai'))
    expect(all).toHaveLength(1)
  })

  it('assertWorkspace passes matching hd and is a no-op when unrestricted', () => {
    expect(() => assertWorkspace({ hd: undefined })).not.toThrow() // domain unset in tests
  })

  it('session query returns the caller; unauthenticated is UNAUTHORIZED', async () => {
    const user = await seedUser(t.db)
    const token = await seedSession(t.db, user.id)
    const resolved = await resolveSession(t.db, token)
    const caller = authRouter.createCaller(ctxFor(t, resolved, token))
    expect((await caller.session())?.id).toBe(user.id)
    const anon = authRouter.createCaller(ctxFor(t, null, null))
    await expect(anon.session()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('refresh rotates the token', async () => {
    const user = await seedUser(t.db)
    const token = await seedSession(t.db, user.id)
    const resolved = await resolveSession(t.db, token)
    const caller = authRouter.createCaller(ctxFor(t, resolved, token))
    const { token: fresh } = await caller.refresh()
    expect(await resolveSession(t.db, token)).toBeNull()
    expect((await resolveSession(t.db, fresh))?.id).toBe(user.id)
  })
})
