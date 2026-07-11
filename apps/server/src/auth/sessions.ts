/**
 * Opaque session tokens (documented stub, plan §deviations #2): 256-bit
 * random, SHA-256-hashed at rest, 30-day sliding TTL (D7's offline window),
 * revoked by row delete. Authenticates both tRPC and the Yjs WebSocket.
 */
import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt } from 'drizzle-orm'
import { config } from '../config'
import type { Db } from '../db/client'
import { sessions, users } from '../db/schema'

export interface SessionUser {
  id: string
  email: string
  name: string | null
  avatarUrl: string | null
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function mintSession(db: Db, userId: string, now = new Date()): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + config.sessionTtlMs),
  })
  return token
}

/** Resolve a bearer token to its user (null if unknown/expired); slides expiry. */
export async function resolveSession(
  db: Db,
  token: string,
  now = new Date(),
): Promise<SessionUser | null> {
  const [row] = await db
    .select({ sessionId: sessions.id, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, now)))
  if (!row) return null
  await db
    .update(sessions)
    .set({ expiresAt: new Date(now.getTime() + config.sessionTtlMs) })
    .where(eq(sessions.id, row.sessionId))
  const { id, email, name, avatarUrl } = row.user
  return { id, email, name, avatarUrl }
}

export async function revokeSession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)))
}
