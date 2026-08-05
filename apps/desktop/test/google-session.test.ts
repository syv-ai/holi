/**
 * `GoogleSession` — the sole token authority.
 *
 * The tests that matter here are the ones protecting properties you cannot see
 * by reading a happy path: that N concurrent callers cause **one** refresh
 * (because Google rotates refresh tokens and a race invalidates the grant),
 * that a rotated refresh token is persisted, and that only a genuinely dead
 * grant disconnects the account.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GOOGLE_SCOPES, GoogleSession } from '../src/main/google/session'
import { GoogleTokenStore, type StoredGoogleAuth } from '../src/main/google/token-store'
import type { LoopbackServer } from '../src/main/google/loopback-flow'

/** `safeStorage`'s shape, with encryption that is just a reversible marker. */
const storage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(`enc:${plain}`),
  decryptString: (buf: Buffer) => buf.toString().replace(/^enc:/, ''),
}

let dir: string
let store: GoogleTokenStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holi-google-'))
  store = new GoogleTokenStore(join(dir, 'google-auth.enc'), storage)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const NOW = 1_000_000

function auth(overrides: Partial<StoredGoogleAuth> = {}): StoredGoogleAuth {
  return {
    sub: 'sub-1',
    email: 'nicolai@syv.ai',
    refreshToken: 'rt-1',
    accessToken: 'at-1',
    expiresAt: NOW + 3_600_000,
    scopes: ['openid'],
    ...overrides,
  }
}

/** A session over a pre-seeded store. */
async function connected(seed: StoredGoogleAuth, fetchImpl?: typeof globalThis.fetch) {
  await store.write({ [seed.sub]: seed })
  return GoogleSession.load({
    store,
    listen: async (): Promise<LoopbackServer> => ({
      port: 1,
      waitForRedirect: () => new Promise(() => {}),
      close: () => {},
    }),
    openBrowser: async () => {},
    clientId: 'client-1',
    fetch: fetchImpl,
    now: () => NOW,
  })
}

/** A token endpoint that counts its calls and answers with `body`. */
function refreshFetch(body: Record<string, unknown>, delayMs = 0) {
  const fn = vi.fn(async () => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
    return {
      ok: true,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }
  })
  return fn as unknown as typeof globalThis.fetch & { mock: { calls: unknown[] } }
}

describe('loading', () => {
  it('reads the keychain and reports the account without exposing tokens', async () => {
    const session = await connected(auth())

    expect(session.account).toEqual({ email: 'nicolai@syv.ai' })
    // The renderer-facing projection carries no token, by construction.
    expect(JSON.stringify(session.account)).not.toContain('rt-1')
    expect(JSON.stringify(session.account)).not.toContain('at-1')
  })

  it('is null when nothing is stored', async () => {
    const session = await GoogleSession.load({
      store,
      listen: async () => ({ port: 1, waitForRedirect: () => new Promise(() => {}), close: () => {} }),
      openBrowser: async () => {},
    })
    expect(session.account).toBeNull()
  })
})

/**
 * A grant older than the scopes the build now asks for.
 *
 * `scopes` has been written on every connect since the connector landed and,
 * until this, read by nothing. That is the whole hazard: widening
 * `GOOGLE_SCOPES` does not invalidate a stored grant, so the refresh token
 * keeps minting tokens for the OLD scopes, every write 403s with `scope`, and
 * the user has no route back but disconnecting by hand. Comparing the two is
 * what turns that into a reconnect prompt.
 */
describe('missingScopes', () => {
  /** The four the connector originally shipped with, before mail could write. */
  const OLD_GRANT = [
    'openid',
    'email',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar.readonly',
  ]

  it('names every scope this build needs that the stored grant does not carry', async () => {
    const session = await connected(auth({ scopes: OLD_GRANT }))

    expect(session.missingScopes()).toEqual([
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/contacts.readonly',
    ])
  })

  it('is empty when the grant covers everything the build asks for', async () => {
    const session = await connected(auth({ scopes: [...GOOGLE_SCOPES] }))

    expect(session.missingScopes()).toEqual([])
  })

  it('understands the scopes as GOOGLE returns them, not as we asked for them', async () => {
    // The bug this exists for, reported from real use: reconnecting cleared
    // nothing and settings went on demanding new permissions forever.
    //
    // Google does not echo the strings you sent. `email` is granted as
    // `.../auth/userinfo.email` (and `profile` likewise); the rest come back
    // verbatim. Comparing the request against the grant therefore reports
    // `email` missing on a grant that is completely correct — and no amount of
    // reconnecting can fix a mismatch that is in the comparison.
    //
    // The original test seeded `[...GOOGLE_SCOPES]`, which encoded what this
    // code assumed rather than what Google sends, so it passed throughout.
    const session = await connected(
      auth({
        scopes: [
          'openid',
          'https://www.googleapis.com/auth/userinfo.email',
          'https://www.googleapis.com/auth/gmail.modify',
          'https://www.googleapis.com/auth/calendar.readonly',
          'https://www.googleapis.com/auth/contacts.readonly',
        ],
      }),
    )

    expect(session.missingScopes()).toEqual([])
  })

  it('still catches a genuinely missing scope on a grant in Google’s own form', async () => {
    // The alias must not become a blanket "close enough" that stops the guard
    // noticing the thing it exists to notice.
    const session = await connected(
      auth({
        scopes: [
          'openid',
          'https://www.googleapis.com/auth/userinfo.email',
          'https://www.googleapis.com/auth/gmail.modify',
          'https://www.googleapis.com/auth/calendar.readonly',
        ],
      }),
    )

    expect(session.missingScopes()).toEqual(['https://www.googleapis.com/auth/contacts.readonly'])
  })

  it('is empty with no account — "not connected" is a different state the UI already renders', async () => {
    const session = await GoogleSession.load({
      store,
      listen: async () => ({ port: 1, waitForRedirect: () => new Promise(() => {}), close: () => {} }),
      openBrowser: async () => {},
    })

    expect(session.missingScopes()).toEqual([])
  })

  it('ignores extra scopes Google granted that this build never asked for', async () => {
    const session = await connected(auth({ scopes: [...GOOGLE_SCOPES, 'https://example.test/extra'] }))

    expect(session.missingScopes()).toEqual([])
  })
})

describe('getAccessToken', () => {
  it('returns the stored token while it is still fresh, with no network call', async () => {
    const fetchImpl = refreshFetch({})
    const session = await connected(auth(), fetchImpl)

    await expect(session.getAccessToken()).resolves.toBe('at-1')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refreshes inside the skew margin rather than waiting for exact expiry', async () => {
    // Expires in 30s — still "valid", but inside the 60s margin.
    const fetchImpl = refreshFetch({ access_token: 'at-2', expires_in: 3600 })
    const session = await connected(auth({ expiresAt: NOW + 30_000 }), fetchImpl)

    await expect(session.getAccessToken()).resolves.toBe('at-2')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('single-flights: concurrent callers cause exactly one refresh', async () => {
    const fetchImpl = refreshFetch({ access_token: 'at-2', expires_in: 3600 }, 5)
    const session = await connected(auth({ expiresAt: NOW - 1 }), fetchImpl)

    const tokens = await Promise.all([
      session.getAccessToken(),
      session.getAccessToken(),
      session.getAccessToken(),
    ])

    expect(tokens).toEqual(['at-2', 'at-2', 'at-2'])
    // The whole reason main is the sole authority: a second refresh here would
    // race a rotating refresh token and could invalidate the grant.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('persists a rotated refresh token, so the next refresh uses the live one', async () => {
    const fetchImpl = refreshFetch({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 })
    const session = await connected(auth({ expiresAt: NOW - 1 }), fetchImpl)

    await session.getAccessToken()

    expect((await store.read())['sub-1']!.refreshToken).toBe('rt-2')
  })

  it('keeps the existing refresh token when the response omits one', async () => {
    const fetchImpl = refreshFetch({ access_token: 'at-2', expires_in: 3600 })
    const session = await connected(auth({ expiresAt: NOW - 1 }), fetchImpl)

    await session.getAccessToken()

    expect((await store.read())['sub-1']!.refreshToken).toBe('rt-1')
  })

  it('throws reconnect-required when nothing is connected', async () => {
    const session = await GoogleSession.load({
      store,
      listen: async () => ({ port: 1, waitForRedirect: () => new Promise(() => {}), close: () => {} }),
      openBrowser: async () => {},
    })
    await expect(session.getAccessToken()).rejects.toThrow(/connect Google again/)
  })
})

describe('a dead grant', () => {
  it('disconnects the account on a 400 (invalid_grant) and asks for a reconnect', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant' }),
      text: async () => '{"error":"invalid_grant"}',
    })) as unknown as typeof globalThis.fetch
    const session = await connected(auth({ expiresAt: NOW - 1 }), fetchImpl)

    await expect(session.getAccessToken()).rejects.toThrow(/expired or been revoked/)
    expect(session.account).toBeNull()
    expect(await store.read()).toEqual({})
  })

  it('does NOT disconnect on a transient server failure', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => 'upstream unavailable',
    })) as unknown as typeof globalThis.fetch
    const session = await connected(auth({ expiresAt: NOW - 1 }), fetchImpl)

    await expect(session.getAccessToken()).rejects.toThrow()
    // A flaky network must never cost the user their connection.
    expect(session.account).toEqual({ email: 'nicolai@syv.ai' })
    expect(await store.read()).not.toEqual({})
  })
})

describe('disconnect', () => {
  it('revokes the refresh token at Google, then clears the keychain', async () => {
    const fetchImpl = refreshFetch({})
    const session = await connected(auth(), fetchImpl)
    const notified: (unknown | null)[] = []
    session.onChange((a) => notified.push(a))

    await session.disconnect()

    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, { body: string }][] } })
      .mock.calls[0]!
    expect(url).toContain('/revoke')
    expect(new URLSearchParams(init.body).get('token')).toBe('rt-1')
    expect(session.account).toBeNull()
    expect(await store.read()).toEqual({})
    expect(notified).toEqual([null])
  })

  it('still clears locally when the revoke call fails — the user asked to disconnect', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof globalThis.fetch
    const session = await connected(auth(), fetchImpl)

    await session.disconnect()

    expect(session.account).toBeNull()
    expect(await store.read()).toEqual({})
  })
})
