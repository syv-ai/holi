/** Seed a dev user + personal vault + welcome doc; print a session token.
 * Run: pnpm --filter @holi/server exec tsx scripts/seed-dev.ts */
import * as Y from 'yjs'
import { YDOC_TEXT_KEY } from '@holi/shared'
import { provisionPersonalVault } from '../src/auth/provision'
import { mintSession } from '../src/auth/sessions'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { docs, users, yjsDocs } from '../src/db/schema'

async function seed(): Promise<void> {
  await runMigrations()
  const { db, sql } = createDb()
  const [user] = await db
    .insert(users)
    .values({ googleSub: 'dev-local', email: 'dev@syv.ai', name: 'Dev' })
    .onConflictDoUpdate({ target: users.googleSub, set: { updatedAt: new Date() } })
    .returning()
  const vaultId = await provisionPersonalVault(db, user!.id)
  const [doc] = await db
    .insert(docs)
    .values({ vaultId, path: `welcome-${Date.now()}.md`, kind: 'note' })
    .returning()
  const ydoc = new Y.Doc()
  ydoc.getText(YDOC_TEXT_KEY).insert(0, '# welcome\n')
  await db.insert(yjsDocs).values({ docId: doc!.id, state: Y.encodeStateAsUpdate(ydoc) })
  const token = await mintSession(db, user!.id)
  console.log(JSON.stringify({ token, vaultId, docId: doc!.id }, null, 2))
  await sql.end()
}

void seed()
