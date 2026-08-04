/**
 * The Google grant's state machine, with no browser and no socket.
 *
 * Everything the flow reaches for is injected, so these tests pin the parts
 * that are invisible until they break in production: the authorization URL's
 * parameters (a missing `prompt=consent` costs you the refresh token an hour
 * later), the state check, and the exchange.
 */
import { describe, expect, it, vi } from 'vitest'
import { startLoopbackFlow, type LoopbackServer } from '../src/main/google/loopback-flow'

/** A JWT-shaped id_token. Only the payload segment is ever read. */
function idToken(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
}

const IDENTITY = { sub: 'google-sub-1', email: 'nicolai@syv.ai' }

const GRANT = {
  access_token: 'at-1',
  refresh_token: 'rt-1',
  expires_in: 3600,
  scope: 'openid email https://www.googleapis.com/auth/gmail.readonly',
  id_token: idToken(IDENTITY),
}

interface FakeServer extends LoopbackServer {
  closed: boolean
}

/** A token endpoint that always answers with `body`. */
function tokenFetch(body: Record<string, unknown>): typeof globalThis.fetch {
  return vi.fn(async () => ({
    ok: true,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof globalThis.fetch
}

/**
 * A flow whose redirect echoes back whatever `state` the authorization URL
 * carried — the honest simulation of a browser round-trip, and the only way to
 * exercise the happy path without hardcoding a state the flow invented.
 *
 * `redirect: null` means the browser never arrives.
 */
async function flowWith(opts: {
  redirect: Record<string, string> | null
  fetch?: typeof globalThis.fetch
  port?: number
  onOpen?: (url: string) => void
}) {
  let state = ''
  const server: FakeServer = {
    port: opts.port ?? 45123,
    closed: false,
    waitForRedirect: () =>
      opts.redirect === null
        ? new Promise<Record<string, string>>(() => {})
        : new Promise((resolve) => setTimeout(() => resolve({ ...opts.redirect, state }), 0)),
    close() {
      server.closed = true
    },
  }

  const flow = await startLoopbackFlow({
    clientId: 'client-1',
    scopes: ['openid', 'email'],
    listen: async () => server,
    openBrowser: async (url) => {
      state = new URL(url).searchParams.get('state') ?? ''
      opts.onOpen?.(url)
    },
    fetch: opts.fetch ?? tokenFetch(GRANT),
    now: () => 1_000_000,
  })

  return { flow, server }
}

describe('the authorization URL', () => {
  it('asks for offline access and forces consent, so a re-connect still yields a refresh token', async () => {
    const { flow } = await flowWith({ redirect: null })
    const params = new URL(flow.authUrl).searchParams

    expect(params.get('access_type')).toBe('offline')
    expect(params.get('prompt')).toBe('consent')
  })

  it('uses S256 PKCE and never puts the verifier in the request', async () => {
    const { flow } = await flowWith({ redirect: null })
    const params = new URL(flow.authUrl).searchParams

    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('code_challenge')).toMatch(/^[\w-]{43}$/)
    expect(flow.authUrl).not.toContain('code_verifier')
  })

  it('redirects to the port the listener actually bound', async () => {
    const { flow } = await flowWith({ redirect: null, port: 51999 })
    expect(new URL(flow.authUrl).searchParams.get('redirect_uri')).toBe('http://127.0.0.1:51999')
  })

  it('opens the system browser at that URL', async () => {
    const opened: string[] = []
    const { flow } = await flowWith({ redirect: null, onOpen: (u) => opened.push(u) })
    expect(opened).toEqual([flow.authUrl])
  })
})

describe('the redirect', () => {
  it('grants when the state matches, carrying tokens, expiry and identity', async () => {
    const { flow } = await flowWith({ redirect: { code: 'auth-code' } })

    const result = await flow.wait()

    expect(result.kind).toBe('granted')
    if (result.kind !== 'granted') return
    expect(result.tokens).toMatchObject({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      sub: IDENTITY.sub,
      email: IDENTITY.email,
      // now() + expires_in
      expiresAt: 1_000_000 + 3_600_000,
    })
    expect(result.tokens.scopes).toContain('https://www.googleapis.com/auth/gmail.readonly')
  })

  it('sends the PKCE verifier and the same redirect_uri at the exchange', async () => {
    const fetchImpl = tokenFetch(GRANT)
    const { flow } = await flowWith({ redirect: { code: 'auth-code' }, fetch: fetchImpl, port: 51999 })

    await flow.wait()

    const body = new URLSearchParams(
      (fetchImpl as unknown as { mock: { calls: [string, { body: string }][] } }).mock.calls[0]![1]!
        .body,
    )
    expect(body.get('code_verifier')).toMatch(/^[\w-]{43}$/)
    expect(body.get('redirect_uri')).toBe('http://127.0.0.1:51999')
    expect(body.get('grant_type')).toBe('authorization_code')
  })

  it('refuses a mismatched state rather than redeeming the code', async () => {
    const fetchImpl = tokenFetch(GRANT)
    let state = ''
    const server: FakeServer = {
      port: 1,
      closed: false,
      // Deliberately does NOT echo the flow's state.
      waitForRedirect: async () => ({ code: 'c', state: 'not-the-state' }),
      close() {
        server.closed = true
      },
    }
    const flow = await startLoopbackFlow({
      clientId: 'client-1',
      scopes: ['openid'],
      listen: async () => server,
      openBrowser: async (url) => {
        state = new URL(url).searchParams.get('state')!
      },
      fetch: fetchImpl,
      now: () => 1_000_000,
    })

    await expect(flow.wait()).rejects.toThrow(/mismatched state/)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(state).not.toBe('not-the-state')
  })

  it('reports a user cancel as an outcome, not an error', async () => {
    const { flow } = await flowWith({ redirect: { error: 'access_denied' } })
    await expect(flow.wait()).resolves.toEqual({ kind: 'denied' })
  })

  it('throws when the exchange returns no refresh token, naming the likely cause', async () => {
    const { refresh_token: _dropped, ...noRefresh } = GRANT
    const { flow } = await flowWith({
      redirect: { code: 'auth-code' },
      fetch: tokenFetch(noRefresh),
    })
    await expect(flow.wait()).rejects.toThrow(/no refresh token/)
  })
})

describe('lifecycle', () => {
  it('closes the listener on a settled outcome, so the port is not held', async () => {
    const { flow, server } = await flowWith({ redirect: { error: 'access_denied' } })
    await flow.wait()
    expect(server.closed).toBe(true)
  })

  it('cancel resolves as cancelled and closes the listener', async () => {
    const { flow, server } = await flowWith({ redirect: null })
    flow.cancel()
    await expect(flow.wait()).resolves.toEqual({ kind: 'cancelled' })
    expect(server.closed).toBe(true)
  })

  it('wait() is idempotent — the exchange runs once however often it is awaited', async () => {
    const fetchImpl = tokenFetch(GRANT)
    const { flow } = await flowWith({ redirect: { code: 'auth-code' }, fetch: fetchImpl })

    const [a, b] = await Promise.all([flow.wait(), flow.wait()])

    expect(a).toEqual(b)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
