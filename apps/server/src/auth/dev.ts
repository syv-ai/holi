/** Local dev bootstrap — the single source of truth for "who is the dev user".
 * Used by both the `auth.devSession` endpoint (desktop auto sign-in) and
 * `scripts/seed-dev.ts` (manual token minting). Dev only; never reachable in
 * production (the endpoint is gated on `config.enableDevAuth`). */
import type { Bus } from '../bus'
import type { Db } from '../db/client'
import { users } from '../db/schema'
import { provisionPersonalVault } from './provision'

const DEV_GOOGLE_SUB = 'dev-local'
const DEV_EMAIL = 'dev@syv.ai'
const DEV_NAME = 'Dev'

export interface DevUser {
  id: string
  email: string
  name: string | null
  vaultId: string
}

/** Upsert the local dev user and their personal vault (both idempotent). */
export async function ensureDevUser(db: Db, bus: Bus): Promise<DevUser> {
  const [user] = await db
    .insert(users)
    .values({ googleSub: DEV_GOOGLE_SUB, email: DEV_EMAIL, name: DEV_NAME })
    .onConflictDoUpdate({ target: users.googleSub, set: { updatedAt: new Date() } })
    .returning()
  const vaultId = await provisionPersonalVault(db, bus, user!.id)
  return { id: user!.id, email: user!.email, name: user!.name, vaultId }
}
