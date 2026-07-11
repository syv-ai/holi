/**
 * Desktop OAuth (auth PRD §Flows): PKCE + system browser + loopback redirect
 * (RFC 8252). The code exchange happens ON THE SERVER (auth.completeGoogle) —
 * the Google client_secret never touches this machine.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function googleAuthorizeUrl(opts: {
  clientId: string
  redirectUri: string
  challenge: string
  state: string
  hd?: string
}): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', opts.clientId)
  url.searchParams.set('redirect_uri', opts.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('code_challenge', opts.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', opts.state)
  if (opts.hd) url.searchParams.set('hd', opts.hd)
  return url.href
}

export interface LoopbackServer {
  redirectUri: string
  waitForCode(): Promise<string>
  close(): void
}

/** Ephemeral 127.0.0.1 listener for the OAuth redirect; state is the CSRF nonce. */
export function createLoopbackServer(expectedState: string, timeoutMs = 5 * 60_000): Promise<LoopbackServer> {
  return new Promise((resolveServer) => {
    let settle: { resolve(code: string): void; reject(err: Error): void }
    const codePromise = new Promise<string>((resolve, reject) => {
      settle = { resolve, reject }
    })
    // the rejection may fire before waitForCode() attaches a handler
    codePromise.catch(() => {})
    const timer = setTimeout(() => settle.reject(new Error('OAuth timed out')), timeoutMs)

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/oauth/callback') {
        res.writeHead(404).end()
        return
      }
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      if (!code || state !== expectedState) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('OAuth state mismatch — try again from Holi.')
        settle.reject(new Error('OAuth state mismatch'))
      } else {
        res
          .writeHead(200, { 'content-type': 'text/html' })
          .end('<html><body><p>Signed in — you can return to Holi.</p></body></html>')
        settle.resolve(code)
      }
      clearTimeout(timer)
      server.close()
    })

    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolveServer({
        redirectUri: `http://127.0.0.1:${port}/oauth/callback`,
        waitForCode: () => codePromise,
        close: () => {
          clearTimeout(timer)
          server.close()
        },
      })
    })
  })
}
