/** GitHub account linking (auth-identity PRD §Linked accounts). The browser
 * flow: tRPC github.startConnect → authorizeUrl (system browser) → GitHub
 * redirects to `${publicBaseUrl}/github/oauth/callback` on the API server →
 * handleCallback exchanges the code server-side and stores the sealed token.
 * State nonces are in-memory: single-node, 10-min TTL, one-shot. */
import { randomBytes } from 'node:crypto'
import { encryptionKey, seal } from '../crypto'
import type { Db } from '../db/client'
import { githubConnections } from '../db/schema'
import type { GithubApi } from './github-api'

const STATE_TTL_MS = 10 * 60_000

export interface GithubOAuthDeps {
  db: Db
  api: GithubApi
  clientId: string
  publicBaseUrl: string
}

export function createGithubOAuth(deps: GithubOAuthDeps) {
  const pending = new Map<string, { userId: string; expiresAt: number }>()

  function authorizeUrl(userId: string): string {
    const state = randomBytes(24).toString('base64url')
    pending.set(state, { userId, expiresAt: Date.now() + STATE_TTL_MS })
    const url = new URL('https://github.com/login/oauth/authorize')
    url.searchParams.set('client_id', deps.clientId)
    url.searchParams.set('redirect_uri', `${deps.publicBaseUrl}/github/oauth/callback`)
    url.searchParams.set('scope', 'repo admin:repo_hook')
    url.searchParams.set('state', state)
    return url.href
  }

  /** Returns the HTML page shown in the user's browser tab. */
  async function handleCallback(params: { code: string; state: string }): Promise<string> {
    const entry = pending.get(params.state)
    pending.delete(params.state)
    if (!entry || entry.expiresAt < Date.now()) throw new Error('unknown or expired OAuth state')
    const { accessToken } = await deps.api.exchangeCode(params.code)
    const ghUser = await deps.api.getUser(accessToken)
    const values = {
      userId: entry.userId,
      githubUserId: ghUser.id,
      githubLogin: ghUser.login,
      tokenCiphertext: seal(accessToken, encryptionKey()),
      updatedAt: new Date(),
    }
    await deps.db
      .insert(githubConnections)
      .values(values)
      .onConflictDoUpdate({ target: githubConnections.userId, set: values })
    return `<!doctype html><meta charset="utf-8"><title>Holi</title>
<body style="font-family:system-ui;padding:3rem"><h1>GitHub connected ✓</h1>
<p>Signed in as <b>${ghUser.login}</b>. You can close this tab and return to Holi.</p>`
  }

  return { authorizeUrl, handleCallback }
}

export type GithubOAuth = ReturnType<typeof createGithubOAuth>
