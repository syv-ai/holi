import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import * as schema from '../db/schema'

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? 'postgres://holi:holi@localhost:5433/holi'
const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url))

export interface TestDb {
  db: ReturnType<typeof drizzle<typeof schema>>
  sql: postgres.Sql
  destroy(): Promise<void>
}

/** Create a uniquely-named database on the compose Postgres, fully migrated. */
export async function createTestDb(): Promise<TestDb> {
  const name = `holi_test_${randomBytes(6).toString('hex')}`
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} })
  await admin.unsafe(`create database ${name}`)
  const url = new URL(ADMIN_URL)
  url.pathname = `/${name}`
  const sql = postgres(url.href, { max: 5, onnotice: () => {} })
  await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR })
  const db = drizzle(sql, { schema })
  return {
    db,
    sql,
    async destroy() {
      await sql.end()
      await admin.unsafe(`drop database ${name} with (force)`)
      await admin.end()
    },
  }
}
