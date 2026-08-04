/**
 * PKCE — the thing that makes a public desktop client safe to ship.
 *
 * A desktop app cannot keep a secret, so the authorization code alone is not
 * enough: anything that can intercept the loopback redirect could redeem it.
 * PKCE binds the code to a random secret this process invented and never sent
 * over the wire until the exchange, so an intercepted code is worthless.
 *
 * Pure and dependency-injected down to the random bytes, so the whole flow is
 * reproducible in a test without stubbing crypto globally.
 */
import { createHash, randomBytes } from 'node:crypto'

/** RFC 7636's alphabet. `base64url` is exactly it, minus the padding. */
function base64url(buf: Buffer): string {
  return buf.toString('base64url')
}

export type RandomBytes = (size: number) => Buffer

/**
 * 32 bytes → 43 base64url chars, comfortably inside RFC 7636's 43–128 range.
 * Anything shorter weakens the binding for no benefit.
 */
export function createVerifier(random: RandomBytes = randomBytes): string {
  return base64url(random(32))
}

/**
 * **`S256`, never `plain`.** `plain` sends the verifier itself in the
 * authorization request, which hands an interceptor the one secret the exchange
 * depends on — it exists in the spec for clients that cannot hash, and we can.
 */
export function challengeFor(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest())
}

/**
 * The CSRF guard. Google echoes it back on the redirect; a mismatch means the
 * response is not the one this flow asked for, and the flow must refuse rather
 * than redeem whatever code it was handed.
 */
export function randomState(random: RandomBytes = randomBytes): string {
  return base64url(random(16))
}
