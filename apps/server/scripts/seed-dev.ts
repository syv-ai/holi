/** Seed the dev user + personal vault + a welcome doc; print a session token.
 * The desktop app auto-signs-in via `auth.devSession` under `pnpm dev`, so this
 * script is only needed to mint a token by hand (e.g. to paste into the dev-token
 * field, or for the CDP e2e probes). Both paths share `ensureDevUser`, so they
 * can never disagree on who the dev user is.
 * Run: pnpm --filter @holi/server exec tsx scripts/seed-dev.ts */
import * as Y from 'yjs'
import { YDOC_TEXT_KEY } from '@holi/shared'
import { ensureDevUser } from '../src/auth/dev'
import { createBus } from '../src/bus'
import { mintSession } from '../src/auth/sessions'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { docs, yjsDocs } from '../src/db/schema'

async function seed(): Promise<void> {
  await runMigrations()
  const { db, sql } = createDb()
  // A throwaway bus: provisioning announces the personal vault (D51) and in this script
  // nothing is listening. The funnel has no exceptions, so the script supplies one rather
  // than provisioning being allowed to skip the announcement.
  const user = await ensureDevUser(db, createBus())
  const [doc] = await db
    .insert(docs)
    .values({ vaultId: user.vaultId, path: `welcome-${Date.now()}.md`, kind: 'note' })
    .returning()
  const ydoc = new Y.Doc()
  ydoc.getText(YDOC_TEXT_KEY).insert(0, '# welcome\n')
  await db.insert(yjsDocs).values({ docId: doc!.id, state: Y.encodeStateAsUpdate(ydoc) })
  const token = await mintSession(db, user.id)
  console.log(JSON.stringify({ token, vaultId: user.vaultId, docId: doc!.id }, null, 2))
  await sql.end()
}

void seed()
