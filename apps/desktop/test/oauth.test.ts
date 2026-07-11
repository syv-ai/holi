import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createLoopbackServer, googleAuthorizeUrl, pkcePair } from '../src/main/oauth'

describe('pkce', () => {
  it('generates a base64url verifier (43 chars) and its S256 challenge', () => {
    const { verifier, challenge } = pkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const expected = createHash('sha256').update(verifier).digest('base64url')
    expect(challenge).toBe(expected)
  })

  it('verifiers are unique per call', () => {
    expect(pkcePair().verifier).not.toBe(pkcePair().verifier)
  })
})

describe('authorize url', () => {
  it('carries every required param', () => {
    const url = new URL(
      googleAuthorizeUrl({
        clientId: 'cid',
        redirectUri: 'http://127.0.0.1:9999/oauth/callback',
        challenge: 'chal',
        state: 'st8',
        hd: 'syv.ai',
      }),
    )
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:9999/oauth/callback')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe('openid email profile')
    expect(url.searchParams.get('code_challenge')).toBe('chal')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('st8')
    expect(url.searchParams.get('hd')).toBe('syv.ai')
  })

  it('omits hd when not configured', () => {
    const url = new URL(
      googleAuthorizeUrl({ clientId: 'c', redirectUri: 'http://127.0.0.1:1/x', challenge: 'y', state: 'z' }),
    )
    expect(url.searchParams.has('hd')).toBe(false)
  })
})

describe('loopback server', () => {
  it('resolves the code for a matching state and rejects a mismatched one', async () => {
    const srv = await createLoopbackServer('expected-state')
    const hit = await fetch(`${srv.redirectUri}?code=the-code&state=expected-state`)
    expect(hit.status).toBe(200)
    await expect(srv.waitForCode()).resolves.toBe('the-code')

    const srv2 = await createLoopbackServer('right')
    const bad = await fetch(`${srv2.redirectUri}?code=x&state=wrong`)
    expect(bad.status).toBe(400)
    await expect(srv2.waitForCode()).rejects.toThrow(/state/)
  })
})
