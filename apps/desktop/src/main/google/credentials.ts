/**
 * The OAuth client Holi presents to Google, and **the one rule for resolving
 * it**: an explicit override, else the environment, else the embedded pair.
 *
 * Its own file because it has two callers that must never drift: `GoogleSession`
 * refreshes with it and `accounts.ts` runs a consent with it. A stray
 * `?? ''` in one of them makes consent die at Google with `Missing required
 * parameter: client_id`.
 */

/**
 * The OAuth client id for Holi's Google app.
 *
 * A desktop client's id is not a secret, and neither is the `client_secret`
 * Google issues alongside it: for an installed app both ship in the binary and
 * **PKCE** is what actually protects the grant.
 *
 * `HOLI_GOOGLE_CLIENT_ID` / `HOLI_GOOGLE_CLIENT_SECRET` in the environment
 * override both, to point a dev build at a different app.
 */
export const GOOGLE_CLIENT_ID =
  '132910330015-4ror8qtmhh69d1ms1s3s99tot5gm551q.apps.googleusercontent.com'

/**
 * The desktop `client_secret` Google issued alongside the id above.
 *
 * **Committed on purpose, and it is not a credential.** Google's own docs say
 * the secret for an installed app "is obviously not treated as a secret": it
 * ships in every copy of the binary. Google requires it on the token exchange
 * for a Desktop-type client; what actually stops a stolen authorization code
 * being redeemed is **PKCE** (`pkce.ts`), which binds the exchange to a
 * verifier that never leaves this process.
 *
 * This pair identifies *Holi*, not a user, and grants nothing on its own: every
 * token still requires the user to complete consent in their own browser.
 */
export const GOOGLE_CLIENT_SECRET = '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'

/** The client id to present: an override, else the environment, else the
 *  embedded registration. Never empty. */
export function resolveClientId(override?: string): string {
  return override ?? process.env.HOLI_GOOGLE_CLIENT_ID ?? GOOGLE_CLIENT_ID
}

/** The client secret to present. `undefined` is a legitimate answer only if
 *  both the override and the embedded constant are gone. */
export function resolveClientSecret(override?: string): string | undefined {
  return override ?? process.env.HOLI_GOOGLE_CLIENT_SECRET ?? GOOGLE_CLIENT_SECRET
}
