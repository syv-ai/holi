import { describe, expect, it, vi } from 'vitest'
import { GitHubApi, GitHubApiError, HOLI_VAULT_TOPIC, type ApiDeps } from '../src/main/github/api'

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

  it('flags a repo as a vault only when it carries the holi-vault topic', async () => {
    const t = api([
      {
        body: [
          repo({ full_name: 'a/vault', topics: [HOLI_VAULT_TOPIC, 'notes'] }),
          repo({ full_name: 'a/code', topics: ['typescript'] }),
          repo({ full_name: 'a/bare' }), // no topics field at all
        ],
      },
    ])
    expect((await t.client.repos()).map((r) => [r.remote, r.isVault])).toEqual([
      ['a/vault', true],
      ['a/code', false],
      ['a/bare', false],
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

const collaborator = (over: Record<string, unknown> = {}) => ({
  login: 'octocat',
  id: 1,
  avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
  permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
  role_name: 'write',
  ...over,
})

describe('GitHubApi.collaborators', () => {
  it('maps a collaborator list to the shared Collaborator type', async () => {
    const t = api([{ body: [collaborator()] }])

    expect(await t.client.collaborators('syv-ai/1brain')).toEqual([
      {
        accountId: 1,
        login: 'octocat',
        avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
        permission: 'write',
      },
    ])
    expect(new URL(t.requests[0].url).pathname).toBe('/repos/syv-ai/1brain/collaborators')
  })

  it('takes the highest permission from the permissions object', async () => {
    // Read from `permissions`, not `role_name`. The object is a fixed set of
    // booleans; role_name is a vocabulary GitHub can extend with custom org
    // roles, and an unrecognised string there has no safe default — guessing
    // high grants access we cannot verify, guessing low hides real admins.
    const t = api([
      {
        body: [
          collaborator({ id: 1, permissions: { admin: true, maintain: true, push: true, triage: true, pull: true }, role_name: 'some_custom_role' }),
          collaborator({ id: 2, permissions: { admin: false, maintain: true, push: true, triage: true, pull: true } }),
          collaborator({ id: 3, permissions: { admin: false, maintain: false, push: false, triage: true, pull: true } }),
          collaborator({ id: 4, permissions: { admin: false, maintain: false, push: false, triage: false, pull: true } }),
        ],
      },
    ])

    expect((await t.client.collaborators('a/b')).map((c) => c.permission)).toEqual([
      'admin',
      'maintain',
      'triage',
      'read',
    ])
  })

  it('paginates', async () => {
    const t = api([
      { body: [collaborator({ id: 1 })], headers: { link: `<${BASE}/c?page=2>; rel="next"` } },
      { body: [collaborator({ id: 2 })] },
    ])

    expect(await t.client.collaborators('a/b')).toHaveLength(2)
    expect(t.requests).toHaveLength(2)
  })

  it('rejects a remote that is not owner/repo', async () => {
    // The value goes into a URL path. This reuses registry.ts's isRemote
    // rather than a second validator that could drift from it.
    const t = api([{ body: [] }])
    await expect(t.client.collaborators('../../etc/passwd')).rejects.toThrow(/owner\/repo/)
    expect(t.requests).toHaveLength(0)
  })
})

describe('GitHubApi.repo', () => {
  it('returns a single repo with its visibility', async () => {
    // The members panel needs this and cannot get it from repos() without
    // listing every repo the user has to read one field. PRD §Edge cases calls
    // a vault silently becoming public the highest-severity thing that can
    // happen to it, and nothing else in the product would show it.
    const t = api([{ body: repo({ visibility: 'public', private: false }) }])

    const r = await t.client.repo('nthomsencph/notes')
    expect(r.visibility).toBe('public')
    expect(r.remote).toBe('nthomsencph/notes')
    expect(new URL(t.requests[0].url).pathname).toBe('/repos/nthomsencph/notes')
  })

  it('reads internal visibility, which is neither public nor private', async () => {
    const t = api([{ body: repo({ visibility: 'internal', private: false }) }])
    expect((await t.client.repo('syv-ai/1brain')).visibility).toBe('internal')
  })
})

describe('GitHubApi.orgs', () => {
  it("lists the viewer's orgs", async () => {
    // The only thing `read:org` was requested for: the New vault owner picker.
    const t = api([
      { body: [{ login: 'syv-ai', avatar_url: 'https://avatars.githubusercontent.com/u/9?v=4' }] },
    ])

    expect(await t.client.orgs()).toEqual([
      { login: 'syv-ai', avatarUrl: 'https://avatars.githubusercontent.com/u/9?v=4' },
    ])
    expect(new URL(t.requests[0].url).pathname).toBe('/user/orgs')
  })
})

describe('GitHubApi.createRepo', () => {
  it('creates a private repo under the viewer by default', async () => {
    const t = api([{ status: 201, body: repo({ full_name: 'nthomsencph/vault' }) }])

    const created = await t.client.createRepo({ name: 'vault' })
    expect(created.remote).toBe('nthomsencph/vault')

    const req = t.requests[0]
    expect(new URL(req.url).pathname).toBe('/user/repos')
    expect(req.method).toBe('POST')
    expect(req.body).toMatchObject({ name: 'vault', private: true })
  })

  it('is private with no way for a caller to ask otherwise', async () => {
    // Not a default the caller may override. A vault created public is the
    // highest-severity thing in the PRD's edge cases, and the type is what
    // makes it unsayable.
    const t = api([{ status: 201, body: repo() }])
    await t.client.createRepo({ name: 'vault', owner: 'syv-ai' })
    expect(t.requests[0].body).toMatchObject({ private: true })
  })

  it('creates under an org when one is given', async () => {
    const t = api([{ status: 201, body: repo({ full_name: 'syv-ai/1brain' }) }])

    await t.client.createRepo({ name: '1brain', owner: 'syv-ai' })
    expect(new URL(t.requests[0].url).pathname).toBe('/orgs/syv-ai/repos')
  })

  it('surfaces a name collision as an error naming the repo', async () => {
    // "already exists" is something the user can fix themselves, but only if
    // they are told which name collided.
    const t = api([
      {
        status: 422,
        body: {
          message: 'Repository creation failed.',
          errors: [{ resource: 'Repository', field: 'name', message: 'name already exists on this account' }],
        },
      },
    ])

    await expect(t.client.createRepo({ name: 'vault' })).rejects.toThrow(/vault/)
  })
})

describe('GitHubApi.markVault', () => {
  it('PUTs the holi-vault topic onto the repo', async () => {
    const t = api([{ body: { names: [HOLI_VAULT_TOPIC] } }])

    await t.client.markVault('nthomsencph/vault')

    const req = t.requests[0]
    expect(new URL(req.url).pathname).toBe('/repos/nthomsencph/vault/topics')
    expect(req.method).toBe('PUT')
    expect(req.body).toEqual({ names: [HOLI_VAULT_TOPIC] })
  })

  it('rejects a remote that is not owner/repo', async () => {
    const t = api([{ body: {} }])
    await expect(t.client.markVault('../../etc')).rejects.toThrow()
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
