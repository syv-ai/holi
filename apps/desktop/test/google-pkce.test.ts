/**
 * PKCE — small enough to read, load-bearing enough to pin.
 *
 * The properties here are the ones RFC 7636 depends on: a verifier long enough
 * to be unguessable, a challenge that is genuinely the SHA-256 of it, and
 * output in the URL-safe alphabet (a `+` or `/` in a query parameter is a
 * corrupted challenge and an inscrutable `invalid_grant`).
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { challengeFor, createVerifier, randomState } from '../src/main/google/pkce'

const URL_SAFE = /^[A-Za-z0-9_-]+$/

describe('createVerifier', () => {
  it('produces a 43-char url-safe string — inside RFC 7636 43..128', () => {
    const verifier = createVerifier()

    expect(verifier).toHaveLength(43)
    expect(verifier).toMatch(URL_SAFE)
  })

  it('differs every call', () => {
    expect(createVerifier()).not.toBe(createVerifier())
  })

  it('uses the injected randomness, so a flow is reproducible in a test', () => {
    const fixed = () => Buffer.alloc(32, 7)
    expect(createVerifier(fixed)).toBe(createVerifier(fixed))
  })
})

describe('challengeFor', () => {
  it('is the base64url SHA-256 of the verifier', () => {
    const verifier = createVerifier()

    expect(challengeFor(verifier)).toBe(
      createHash('sha256').update(verifier).digest('base64url'),
    )
  })

  it('is url-safe and unpadded — no +, / or = to corrupt a query parameter', () => {
    const challenge = challengeFor(createVerifier())

    expect(challenge).toMatch(URL_SAFE)
    expect(challenge).not.toContain('=')
  })

  it('is not the verifier itself — S256 must actually hash', () => {
    const verifier = createVerifier()
    expect(challengeFor(verifier)).not.toBe(verifier)
  })
})

describe('randomState', () => {
  it('is url-safe and unguessable-length', () => {
    const state = randomState()

    expect(state).toMatch(URL_SAFE)
    expect(state.length).toBeGreaterThanOrEqual(22)
  })

  it('differs every call — it is a CSRF guard, not a constant', () => {
    expect(randomState()).not.toBe(randomState())
  })
})
