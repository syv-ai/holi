/** GitHub REST client. Interface-first so wiring code is testable with a fake
 * (src/test/git.ts). Only used at connect/disconnect + OAuth time — the
 * background sync loop never calls the GitHub API. */

export interface GithubApi {
  exchangeCode(code: string): Promise<{ accessToken: string }>
  getUser(token: string): Promise<{ id: number; login: string }>
  getRepo(token: string, owner: string, repo: string): Promise<{ defaultBranch: string; admin: boolean }>
  createDeployKey(token: string, owner: string, repo: string, title: string, key: string): Promise<{ id: number }>
  deleteDeployKey(token: string, owner: string, repo: string, id: number): Promise<void>
  createWebhook(token: string, owner: string, repo: string, url: string, secret: string): Promise<{ id: number }>
  deleteWebhook(token: string, owner: string, repo: string, id: number): Promise<void>
}

export interface GithubApiOptions {
  clientId: string
  clientSecret: string
  /** Overridable for tests. */
  apiBaseUrl?: string
  oauthBaseUrl?: string
}

export function createGithubApi(opts: GithubApiOptions): GithubApi {
  const api = opts.apiBaseUrl ?? 'https://api.github.com'
  const oauth = opts.oauthBaseUrl ?? 'https://github.com'

  async function call<T>(token: string | null, method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'holi-server',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) throw new Error(`GitHub API ${method} ${path} failed: ${res.status} ${await res.text()}`)
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  return {
    async exchangeCode(code) {
      const res = await fetch(`${oauth}/login/oauth/access_token`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'holi-server' },
        body: JSON.stringify({ client_id: opts.clientId, client_secret: opts.clientSecret, code }),
      })
      if (!res.ok) throw new Error(`GitHub code exchange failed: ${res.status}`)
      const data = (await res.json()) as { access_token?: string; error_description?: string }
      if (!data.access_token) throw new Error(`GitHub code exchange failed: ${data.error_description ?? 'no token'}`)
      return { accessToken: data.access_token }
    },
    async getUser(token) {
      const u = await call<{ id: number; login: string }>(token, 'GET', '/user')
      return { id: u.id, login: u.login }
    },
    async getRepo(token, owner, repo) {
      const r = await call<{ default_branch: string; permissions?: { admin?: boolean } }>(
        token,
        'GET',
        `/repos/${owner}/${repo}`,
      )
      return { defaultBranch: r.default_branch, admin: r.permissions?.admin ?? false }
    },
    async createDeployKey(token, owner, repo, title, key) {
      const k = await call<{ id: number }>(token, 'POST', `/repos/${owner}/${repo}/keys`, {
        title,
        key,
        read_only: false,
      })
      return { id: k.id }
    },
    async deleteDeployKey(token, owner, repo, id) {
      await call<void>(token, 'DELETE', `/repos/${owner}/${repo}/keys/${id}`)
    },
    async createWebhook(token, owner, repo, url, secret) {
      const h = await call<{ id: number }>(token, 'POST', `/repos/${owner}/${repo}/hooks`, {
        name: 'web',
        active: true,
        events: ['push'],
        config: { url, secret, content_type: 'json' },
      })
      return { id: h.id }
    },
    async deleteWebhook(token, owner, repo, id) {
      await call<void>(token, 'DELETE', `/repos/${owner}/${repo}/hooks/${id}`)
    },
  }
}
