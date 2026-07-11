import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mintSession, resolveSession, revokeSession } from '../src/auth/sessions'
import { sessions, users } from '../src/db/schema'
import { createTestDb, type TestDb } from '../src/test/db'

describe('sessions', () => {
  let t: TestDb
  let userId: string
  beforeAll(async () => {
    t = await createTestDb()
    const [u] = await t.db
      .insert(users)
      .values({ googleSub: 's1', email: 'n@syv.ai' })
      .returning()
    userId = u!.id
  })
  afterAll(() => t.destroy())

  it('mint → resolve round-trips the user', async () => {
    const token = await mintSession(t.db, userId)
    const user = await resolveSession(t.db, token)
    expect(user?.id).toBe(userId)
    expect(user?.email).toBe('n@syv.ai')
  })

  it('stores only a hash, never the token', async () => {
    const token = await mintSession(t.db, userId)
    const rows = await t.db.select().from(sessions)
    expect(rows.some((r) => r.tokenHash === token)).toBe(false)
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.tokenHash))).toBe(true)
  })

  it('rejects unknown and expired tokens', async () => {
    expect(await resolveSession(t.db, 'garbage')).toBeNull()
    const token = await mintSession(t.db, userId)
    const past = new Date(Date.now() + 31 * 24 * 3_600_000)
    expect(await resolveSession(t.db, token, past)).toBeNull()
  })

  it('slides expiry on resolve', async () => {
    const token = await mintSession(t.db, userId)
    const before = (await t.db.select().from(sessions)).map((r) => r.expiresAt.getTime())
    const later = new Date(Date.now() + 10 * 24 * 3_600_000)
    await resolveSession(t.db, token, later)
    const after = (await t.db.select().from(sessions)).map((r) => r.expiresAt.getTime())
    expect(Math.max(...after)).toBeGreaterThan(Math.max(...before))
  })

  it('revoke kills the session immediately', async () => {
    const token = await mintSession(t.db, userId)
    await revokeSession(t.db, token)
    expect(await resolveSession(t.db, token)).toBeNull()
  })
})
