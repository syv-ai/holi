import { describe, expect, it, vi } from 'vitest'
import { GitHubApi, GitHubApiError, type ApiDeps } from '../src/main/github/api'

interface Recorded {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

interface Scripted {
  status?: number
  body: unknown
  headers?: Record<string, string>
}

/** A scripted `fetch`. Responses are handed out in order; the last one repeats. */
function fakeFetch(script: Scripted[]) {
  const requests: Recorded[] = []
  let i = 0

  const fetch = (async (input: unknown, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    const next = script[Math.min(i++, script.length - 1)]
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...next.headers },
    })
  }) as unknown as typeof globalThis.fetch

  return { fetch, requests }
}

const TOKEN = 'gho_16C7e42F292c6912E7710c838347Ae178B4a'
const BASE = 'https://api.github.test'

function api(script: Scripted[], over: Partial<ApiDeps> = {}) {
  const net = fakeFetch(script)
  const client = new GitHubApi({
    token: () => TOKEN,
    fetch: net.fetch,
    baseUrl: BASE,
    ...over,
  })
  return { client, ...net }
}

const VIEWER = {
  login: 'nthomsencph',
  id: 583231,
  avatar_url: 'https://avatars.githubusercontent.com/u/583231?v=4',
  name: null,
  type: 'User',
}

const repo = (over: Record<string, unknown> = {}) => ({
  name: 'notes',
  full_name: 'nthomsencph/notes',
  private: true,
  owner: { login: 'nthomsencph', id: 583231, type: 'User' },
  default_branch: 'main',
  pushed_at: '2026-07-20T10:00:00Z',
  permissions: { admin: true, push: true, pull: true },
  ...over,
})

describe('GitHubApi requests', () => {
  it('sends the token, the accept header and the api version', async () => {
    const t = api([{ body: VIEWER }])
    await t.client.viewer()

    const h = t.requests[0].headers
    expect(h.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(h.Accept).toBe('application/vnd.github+json')
    // Pinning the version is what stops a future default from quietly
    // reshaping a response under us.
    expect(h['X-GitHub-Api-Version']).toBe('2022-11-28')
  })

  it('sends no Authorization header when signed out', async () => {
    // The request still goes out. A 401 is then the thing that reports it,
    // in one place, rather than two code paths that both mean "signed out".
    const t = api([{ body: VIEWER }], { token: () => null })
    await t.client.viewer()

    expect(t.requests[0].headers.Authorization).toBeUndefined()
  })

  it('reads the token lazily on every request', async () => {
    // This is what makes a sign-out take effect on the next call rather than
    // the next restart — the same reason GitDeps.token is a getter.
    let current: string | null = 'gho_first'
    const t = api([{ body: VIEWER }], { token: () => current })

    await t.client.viewer()
    current = 'gho_second'
    await t.client.viewer()

    expect(t.requests[0].headers.Authorization).toBe('Bearer gho_first')
    expect(t.requests[1].headers.Authorization).toBe('Bearer gho_second')
  })
})

describe('GitHubApi.viewer', () => {
  it('maps the viewer response', async () => {
    const t = api([{ body: VIEWER }])

    expect(await t.client.viewer()).toEqual({
      accountId: 583231,
      login: 'nthomsencph',
      // GitHub really does send `null` here, and the string "null" in a UI is
      // the classic tell that nobody checked.
      name: undefined,
      avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4',
    })
    expect(t.requests[0].url).toBe(`${BASE}/user`)
  })

  it('keeps a name when there is one', async () => {
    const t = api([{ body: { ...VIEWER, name: 'Nicolai Thomsen' } }])
    expect((await t.client.viewer()).name).toBe('Nicolai Thomsen')
  })
})

describe('GitHubApi.repos', () => {
  it('requests 100 per page sorted by pushed, across every affiliation', async () => {
    const t = api([{ body: [repo()] }])
    await t.client.repos()

    const url = new URL(t.requests[0].url)
    expect(url.pathname).toBe('/user/repos')
    expect(url.searchParams.get('per_page')).toBe('100')
    expect(url.searchParams.get('sort')).toBe('pushed')
    // Stated rather than left to the default: this is the one line that makes
    // org-owned vaults appear in the picker, and a changed default would
    // remove them silently.
    expect(url.searchParams.get('affiliation')).toBe('owner,collaborator,organization_member')
  })

  it('follows the Link header to the next page', async () => {
    // A user with more than 100 repos otherwise loses the tail — and the vault
    // they are hunting for is disproportionately likely to be in it.
    const t = api([
      {
        body: [repo({ full_name: 'nthomsencph/one' })],
        headers: { link: `<${BASE}/user/repos?page=2>; rel="next", <${BASE}/user/repos?page=2>; rel="last"` },
      },
      { body: [repo({ full_name: 'nthomsencph/two' })] },
    ])

    const repos = await t.client.repos()
    expect(repos.map((r) => r.remote)).toEqual(['nthomsencph/one', 'nthomsencph/two'])
    expect(t.requests).toHaveLength(2)
    expect(t.requests[1].url).toBe(`${BASE}/user/repos?page=2`)
  })

  it('maps owner kind from the owner type', async () => {
    // Both must work: this is the grouping the picker uses, and Nicolai's
    // vaults live under personal accounts *and* orgs.
    const t = api([
      {
        body: [
          repo({ full_name: 'syv-ai/1brain', owner: { login: 'syv-ai', id: 9, type: 'Organization' } }),
          repo({ full_name: 'nthomsencph/notes' }),
        ],
      },
    ])

    const repos = await t.client.repos()
    expect(repos.map((r) => r.owner)).toEqual([
      { login: 'syv-ai', kind: 'org' },
      { login: 'nthomsencph', kind: 'user' },
    ])
  })

  it('carries canPush from permissions.push', async () => {
    // A repo you cannot push to would become a vault that cannot publish.
    const t = api([
      {
        body: [
          repo({ full_name: 'a/readonly', permissions: { admin: false, push: false, pull: true } }),
          repo({ full_name: 'a/writable' }),
        ],
      },
    ])

    const repos = await t.client.repos()
    expect(repos.find((r) => r.remote === 'a/readonly')?.canPush).toBe(false)
    expect(repos.find((r) => r.remote === 'a/writable')?.canPush).toBe(true)
  })

  it('returns them newest push first', async () => {
    const t = api([
      {
        body: [
          repo({ full_name: 'a/old', pushed_at: '2024-01-01T00:00:00Z' }),
          repo({ full_name: 'a/new', pushed_at: '2026-07-21T00:00:00Z' }),
          repo({ full_name: 'a/mid', pushed_at: '2025-06-01T00:00:00Z' }),
        ],
      },
    ])

    expect((await t.client.repos()).map((r) => r.remote)).toEqual(['a/new', 'a/mid', 'a/old'])
  })

  it('maps private and default branch', async () => {
    const t = api([{ body: [repo({ private: false, default_branch: 'trunk' })] }])
    const [r] = await t.client.repos()
    expect(r.private).toBe(false)
    expect(r.defaultBranch).toBe('trunk')
  })
})

describe('GitHubApi errors', () => {
  it('classifies 401 as unauthorized and calls onUnauthorized', async () => {
    const onUnauthorized = vi.fn()
    const t = api([{ status: 401, body: { message: 'Bad credentials' } }], { onUnauthorized })

    await expect(t.client.viewer()).rejects.toMatchObject({ status: 401, kind: 'unauthorized' })
    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  it('classifies a plain 403 as forbidden and does NOT call onUnauthorized', async () => {
    // The sharpest assertion in this file. A 403 is a repo you cannot read —
    // signing someone out for clicking one is a bug that looks like a feature.
    const onUnauthorized = vi.fn()
    const t = api([{ status: 403, body: { message: 'Must have admin rights' } }], { onUnauthorized })

    await expect(t.client.collaborators('syv-ai/1brain')).rejects.toMatchObject({
      status: 403,
      kind: 'forbidden',
    })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('classifies 403 with no remaining rate limit as rate-limited', async () => {
    // Checked *before* the permission reading, because both are 403s.
    const t = api([
      {
        status: 403,
        body: { message: 'API rate limit exceeded' },
        headers: { 'x-ratelimit-remaining': '0' },
      },
    ])

    await expect(t.client.repos()).rejects.toMatchObject({ kind: 'rate-limited' })
  })

  it('classifies 429 as rate-limited', async () => {
    const t = api([{ status: 429, body: { message: 'Too many requests' } }])
    await expect(t.client.repos()).rejects.toMatchObject({ kind: 'rate-limited' })
  })

  it('classifies 403 with X-GitHub-SSO as saml-required and extracts the url', async () => {
    // "403 Forbidden" is not actionable. "Authorize this token for your org",
    // with the link, is.
    const sso =
      'required; url=https://github.com/orgs/syv-ai/sso?authorization_request=AB4CkQ'
    const t = api([
      { status: 403, body: { message: 'Resource protected by organization SAML enforcement' }, headers: { 'x-github-sso': sso } },
    ])

    await expect(t.client.repos()).rejects.toMatchObject({
      kind: 'saml-required',
      ssoUrl: 'https://github.com/orgs/syv-ai/sso?authorization_request=AB4CkQ',
    })
  })

  it('classifies 404 as not-found', async () => {
    const t = api([{ status: 404, body: { message: 'Not Found' } }])
    await expect(t.client.repo('a/gone')).rejects.toMatchObject({ kind: 'not-found' })
  })

  it('classifies anything else as other', async () => {
    const t = api([{ status: 500, body: { message: 'Server Error' } }])
    await expect(t.client.viewer()).rejects.toMatchObject({ kind: 'other', status: 500 })
  })

  it('never puts the token in the error', async () => {
    // An error may carry a response body. It must never carry request headers.
    const t = api([{ status: 500, body: { message: 'Server Error' } }])

    const err = await t.client.viewer().catch((e: GitHubApiError) => e)
    expect(err).toBeInstanceOf(GitHubApiError)
    expect(err.message).not.toContain(TOKEN)
    expect(JSON.stringify(err)).not.toContain(TOKEN)
  })
})
