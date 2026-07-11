/**
 * Google Workspace SSO (D7): authorization-code flow, hd-restricted.
 * The `hd` param on the auth URL is a UI hint only — the ID token's `hd`
 * claim is the authoritative check (assertWorkspace).
 */
import { and, eq, like } from 'drizzle-orm'
import { OAuth2Client, type TokenPayload } from 'google-auth-library'
import { config } from '../config'
import type { Db } from '../db/client'
import { users } from '../db/schema'

export interface GoogleProfile {
  sub: string
  email: string
  name?: string
  avatarUrl?: string
}

function oauthClient(): OAuth2Client {
  const { clientId, clientSecret, redirectUri } = config.google
  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth not configured (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)')
  }
  return new OAuth2Client({ clientId, clientSecret, redirectUri })
}

export function googleAuthUrl(): string {
  return oauthClient().generateAuthUrl({
    scope: ['openid', 'email', 'profile'],
    hd: config.google.workspaceDomain,
  })
}

/** Enforce the Workspace restriction against the verified ID-token payload. */
export function assertWorkspace(payload: Pick<TokenPayload, 'hd'>): void {
  const domain = config.google.workspaceDomain
  if (domain && payload.hd !== domain) {
    throw new Error(`Google account is not in the ${domain} workspace`)
  }
}

export async function exchangeGoogleCode(code: string): Promise<GoogleProfile> {
  const client = oauthClient()
  const { tokens } = await client.getToken(code)
  if (!tokens.id_token) throw new Error('Google token exchange returned no id_token')
  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: config.google.clientId,
  })
  const payload = ticket.getPayload()
  if (!payload?.sub || !payload.email) throw new Error('Google ID token missing sub/email')
  assertWorkspace(payload)
  return { sub: payload.sub, email: payload.email, name: payload.name, avatarUrl: payload.picture }
}

/** Upsert by google_sub — profile fields refresh on every sign-in. First
 * sign-in claims an invited stub row (`pending:<email>`) by email. */
export async function upsertGoogleUser(db: Db, profile: GoogleProfile) {
  const [claimed] = await db
    .update(users)
    .set({
      googleSub: profile.sub,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
      updatedAt: new Date(),
    })
    .where(and(eq(users.email, profile.email), like(users.googleSub, 'pending:%')))
    .returning()
  if (claimed) return claimed
  const [user] = await db
    .insert(users)
    .values({
      googleSub: profile.sub,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
    })
    .onConflictDoUpdate({
      target: users.googleSub,
      set: {
        email: profile.email,
        name: profile.name,
        avatarUrl: profile.avatarUrl,
        updatedAt: new Date(),
      },
    })
    .returning()
  return user!
}
