import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { config } from '../config'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url))

/** Apply pending migrations. Runs on boot (main.ts) and via `pnpm db:migrate`. */
export async function runMigrations(url: string = config.databaseUrl): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR })
  } finally {
    await sql.end()
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => console.log('[db] migrations applied'))
    .catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
}
