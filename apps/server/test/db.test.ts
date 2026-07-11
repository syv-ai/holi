import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { users } from '../src/db/schema'
import { createTestDb, type TestDb } from '../src/test/db'

describe('test database', () => {
  let t: TestDb
  beforeAll(async () => {
    t = await createTestDb()
  })
  afterAll(() => t.destroy())

  it('migrates and round-trips a row', async () => {
    const [row] = await t.db
      .insert(users)
      .values({ googleSub: 'sub-1', email: 'a@syv.ai', name: 'A' })
      .returning()
    expect(row?.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(row?.email).toBe('a@syv.ai')
  })
})
