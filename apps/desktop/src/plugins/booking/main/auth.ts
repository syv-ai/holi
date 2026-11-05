/**
 * Signing in to the booking site, and staying signed in.
 *
 * The site signs people in with an emailed login link (Supabase's magic link).
 * Holi asks for that email itself with a PKCE challenge, so the link it gets
 * back is useless to anyone without the verifier Holi kept in memory: a link
 * forwarded or read by someone else cannot sign them in as you. Once the link
 * (or a code, for a template that sends one) is handed to `finish`, the
 * session is stored encrypted and refreshed on use.
 *
 * Refresh tokens rotate, so refreshing is single-flight: two callers racing a
 * refresh would spend the same token twice and sign the person out.
 */
import { createHash, randomBytes } from 'node:crypto'
import { BookingApiError, type AuthTokens, type BookingApi } from './api'
import type { SessionStore } from './session-store'

/** Refresh this long before the access token runs out: well before the
 *  site's own margin (Supabase's client renews inside 90 seconds). A site that
 *  renewed first would rotate the refresh token in a cookie Holi never reads,
 *  and Holi's next refresh, with the old one, would sign the person out. */
const REFRESH_EARLY_MS = 5 * 60_000
/** A pending login link is good for as long as the site's (an hour by default). */
const PENDING_MS = 60 * 60_000

interface PendingLogin {
  email: string
  /** Epoch ms the email was asked for: only mail after it can carry the link. */
  sentAt: number
}

export interface BookingAuth {
  /** The signed-in person, or null. */
  current(): Promise<{ email: string; userId: string } | null>
  /** The login email in flight, if any. */
  pending(): PendingLogin | null
  /** Ask the site to email a login link. */
  start(email: string): Promise<PendingLogin>
  /** Finish with what the email carried: its link, or a one-time code. */
  finish(input: string): Promise<{ email: string }>
  /** The current session, refreshed when its access token is about to
   *  expire: what the site's own routes read, from a cookie. Throws
   *  `BookingApiError('auth')` when nobody is signed in. */
  session(): Promise<AuthTokens>
  signOut(): Promise<void>
}

export function createBookingAuth(deps: {
  api: BookingApi
  store: SessionStore
  now?: () => number
}): BookingAuth {
  const now = deps.now ?? Date.now
  let pending: (PendingLogin & { verifier: string }) | null = null
  let refreshing: Promise<AuthTokens> | null = null
  /** Bumped by every sign-in and sign-out, so a refresh that was in flight
   *  across one does not write the session it replaced back over it. */
  let generation = 0

  const live = (): (PendingLogin & { verifier: string }) | null =>
    pending !== null && now() - pending.sentAt < PENDING_MS ? pending : null

  async function save(tokens: AuthTokens, fallbackEmail: string): Promise<AuthTokens> {
    const kept = { ...tokens, email: tokens.email || fallbackEmail }
    await deps.store.write(kept)
    return kept
  }

  async function fresh(): Promise<AuthTokens> {
    // Taken before the read: a sign-out may land while the file is read.
    const started = generation
    const held = await deps.store.read()
    if (held === null) throw new BookingApiError('auth', 'not signed in to the booking site')
    if (held.expiresAt - now() > REFRESH_EARLY_MS) return held
    refreshing ??= (async () => {
      try {
        const renewed = await deps.api.refresh(held.refreshToken)
        if (started !== generation) {
          throw new BookingApiError('auth', 'the booking sign-in changed while it was renewed')
        }
        return await save(renewed, held.email)
      } catch (err) {
        // A site not answering, or asking to wait, leaves the session as it is.
        if (!(err instanceof BookingApiError)) throw err
        if (err.kind === 'network' || err.kind === 'rate-limited') throw err
        // A session that moved on meanwhile (a sign-in, or a caller that read
        // the file just before another refresh rewrote it) is the answer.
        const latest = await deps.store.read()
        if (latest !== null && latest.refreshToken !== held.refreshToken) return latest
        // Otherwise the site refused it: the session is dead, unless a
        // sign-in or sign-out landed meanwhile and the file is that one's.
        if (started === generation) await deps.store.clear()
        throw new BookingApiError('auth', `the booking sign-in has ended (${err.message})`)
      } finally {
        refreshing = null
      }
    })()
    return refreshing
  }

  return {
    async current() {
      const held = await deps.store.read()
      return held === null ? null : { email: held.email, userId: held.userId }
    },

    pending: () => {
      const p = live()
      return p === null ? null : { email: p.email, sentAt: p.sentAt }
    },

    async start(email) {
      const verifier = randomBytes(32).toString('base64url')
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      await deps.api.sendLoginEmail(email, challenge)
      pending = { email, verifier, sentAt: now() }
      return { email, sentAt: pending.sentAt }
    },

    async finish(input) {
      const text = input.trim()
      const p = live()
      // Asked before a link is followed, which spends it.
      if (p === null) {
        throw new BookingApiError('auth', 'Holi did not start this login: send a login email first')
      }
      const tokens = /^\d{6,10}$/.test(text)
        ? await deps.api.verifyCode(p.email, text)
        : await deps.api.exchangeCode((await deps.api.followLoginLink(text)).code, p.verifier)
      generation++
      const kept = await save(tokens, p.email)
      pending = null
      return { email: kept.email }
    },

    session: () => fresh(),

    async signOut() {
      pending = null
      generation++
      const held = await deps.store.read()
      await deps.store.clear()
      if (held !== null) await deps.api.signOut(held.accessToken).catch(() => {})
    },
  }
}
