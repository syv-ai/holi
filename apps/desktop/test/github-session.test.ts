import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { GitHubSession } from '../src/main/github/session'
import { TokenStore, type SafeStorageLike, type StoredAuth } from '../src/main/github/token-store'
import { VaultRegistry } from '../src/main/vault/registry'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

async function scratch(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'holi-sess-'))
  dirs.push(d)
  return d
}

/** Reversible, and deliberately not the identity function — see the token-store suite. */
const storage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${Buffer.from(plain, 'utf8').toString('base64')}`),
  decryptString: (buf) => Buffer.from(buf.toString('utf8').slice(4), 'base64').toString('utf8'),
}

interface Scripted {
  status?: number
  body: unknown
  headers?: Record<string, string>
}

/**
 * A `fetch` routed by pathname, so the device flow (github.com) and the API
 * (api.github.com) can be scripted together and the real URLs stay under test.
 * Each route's last response repeats.
 */
function fakeNet(routes: Record<string, Scripted[]>) {
  const requests: string[] = []
  const cursor = new Map<string, number>()

  const fetch = (async (input: unknown) => {
    const url = new URL(String(input))
    requests.push(url.pathname)

    const script = routes[url.pathname]
    if (!script) throw new Error(`unrouted request: ${url.pathname}`)

    const i = cursor.get(url.pathname) ?? 0
    cursor.set(url.pathname, i + 1)
    const next = script[Math.min(i, script.length - 1)]!

    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...next.headers },
    })
  }) as unknown as typeof globalThis.fetch

  return { fetch, requests }
}

const TOKEN = 'gho_16C7e42F292c6912E7710c838347Ae178B4a'

const CODE = {
  device_code: '3584d83530557fdd1f46af8289938c8ef79f9dc5',
  user_code: 'WDJB-MJHT',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5,
}

const GRANT = { access_token: TOKEN, token_type: 'bearer', scope: 'repo,read:user,read:org' }

const VIEWER = {
  login: 'nthomsencph',
  id: 583231,
  avatar_url: 'https://avatars.githubusercontent.com/u/583231?v=4',
  name: 'Nicolai Thomsen',
  type: 'User',
}

const stored = (over: Partial<StoredAuth> = {}): StoredAuth => ({
  token: TOKEN,
  accountId: 583231,
  login: 'nthomsencph',
  name: 'Nicolai Thomsen',
  avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4',
  scopes: ['repo', 'read:user', 'read:org'],
  ...over,
})

/** A session over a real TokenStore in a tmpdir and a scripted network. */
async function session(routes: Record<string, Scripted[]>, seed?: StoredAuth) {
  const store = new TokenStore(join(await scratch(), 'github-auth.enc'), storage)
  if (seed) await store.write(seed)

  const net = fakeNet(routes)
  const s = await GitHubSession.load({
    store,
    clientId: 'Iv1.test0client0id',
    fetch: net.fetch,
    // The flow's sleeps cost nothing and never advance a real clock.
    sleep: async () => {},
  })
  return { s, store, ...net }
}

const SIGN_IN_ROUTES = {
  '/login/device/code': [{ body: CODE }],
  '/login/oauth/access_token': [{ body: GRANT }],
  '/user': [{ body: VIEWER }],
}

describe('GitHubSession', () => {
  it('loads signed out when the store is empty', async () => {
    const t = await session({})
    expect(t.s.viewer).toBeNull()
    expect(t.s.token()).toBeNull()
  })

  it('loads the cached viewer offline', async () => {
    // FR-6 caches identity for offline display, and FR-16 says a vault opens
    // with no network at all. So load() must not reach for the network — the
    // assertion is that it made no request, not that it recovered from one.
    const t = await session({}, stored())

    expect(t.s.viewer).toEqual({
      accountId: 583231,
      login: 'nthomsencph',
      name: 'Nicolai Thomsen',
      avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4',
    })
    expect(t.s.token()).toBe(TOKEN)
    expect(t.requests).toHaveLength(0)
  })

  it('returns the code before the grant exists', async () => {
    const t = await session(SIGN_IN_ROUTES)
    const flow = await t.s.signIn()

    expect(flow.code.userCode).toBe('WDJB-MJHT')
    expect(t.s.viewer).toBeNull()
    expect(await t.store.read()).toBeNull()
  })

  it('stores the token and viewer on grant', async () => {
    const t = await session(SIGN_IN_ROUTES)
    const result = await (await t.s.signIn()).wait()

    expect(result.kind).toBe('granted')
    expect(t.s.token()).toBe(TOKEN)
    expect(t.s.viewer?.accountId).toBe(583231)
    // Persisted *before* wait() settled: a caller that navigates on resolution
    // must not be able to beat the write.
    expect((await t.store.read())?.token).toBe(TOKEN)
    expect((await t.store.read())?.scopes).toEqual(['repo', 'read:user', 'read:org'])
  })

  it('leaves the session signed out on denied', async () => {
    const t = await session({
      ...SIGN_IN_ROUTES,
      '/login/oauth/access_token': [{ body: { error: 'access_denied' } }],
    })

    expect(await (await t.s.signIn()).wait()).toEqual({ kind: 'denied' })
    expect(t.s.token()).toBeNull()
    expect(t.s.viewer).toBeNull()
    expect(await t.store.read()).toBeNull()
  })

  it('clears the store and the viewer on sign-out', async () => {
    const t = await session(SIGN_IN_ROUTES, stored())
    await t.s.signOut()

    // Immediately, not after a reload — the getter is what git holds.
    expect(t.s.token()).toBeNull()
    expect(t.s.viewer).toBeNull()
    expect(await t.store.read()).toBeNull()
  })

  it('does not touch the clone paths on sign-out', async () => {
    // FR-15: deleting someone's files — which may hold unpushed commits — is
    // not a sign-out side effect. The session does not even know the registry
    // exists, and this is the test that keeps it that way.
    const dir = await scratch()
    const registry = new VaultRegistry(join(dir, 'vaults.json'))
    await registry.add({
      remote: 'syv-ai/1brain',
      path: join(dir, 'clone'),
      name: '1brain',
      lastOpenedAt: '2026-07-22T10:00:00Z',
    })

    const t = await session(SIGN_IN_ROUTES, stored())
    await t.s.signOut()

    expect(await registry.list()).toHaveLength(1)
  })

  it('signs the session out on a 401 from the api', async () => {
    const t = await session(
      { '/user/repos': [{ status: 401, body: { message: 'Bad credentials' } }] },
      stored(),
    )

    await expect(t.s.api.repos()).rejects.toMatchObject({ kind: 'unauthorized' })
    expect(t.s.token()).toBeNull()
    expect(t.s.viewer).toBeNull()
    expect(await t.store.read()).toBeNull()
  })

  it('does NOT sign the session out on a 403 from the api', async () => {
    // The mirror of the test above, and the one that will regress. A 403 is a
    // repo you cannot read, a rate limit, or SAML — none mean the token died.
    const t = await session(
      { '/user/repos': [{ status: 403, body: { message: 'Must have admin rights' } }] },
      stored(),
    )

    await expect(t.s.api.repos()).rejects.toMatchObject({ kind: 'forbidden' })
    expect(t.s.token()).toBe(TOKEN)
    expect(t.s.viewer).not.toBeNull()
    expect(await t.store.read()).not.toBeNull()
  })

  it('fires onChange on sign-in, sign-out and a 401', async () => {
    const t = await session({
      ...SIGN_IN_ROUTES,
      '/user/repos': [{ status: 401, body: { message: 'Bad credentials' } }],
    })
    const seen: (string | null)[] = []
    t.s.onChange((v) => seen.push(v?.login ?? null))

    await (await t.s.signIn()).wait()
    await t.s.api.repos().catch(() => {})
    await t.s.signOut()

    expect(seen).toEqual(['nthomsencph', null, null])
  })

  it('stops firing onChange after unsubscribe', async () => {
    const t = await session(SIGN_IN_ROUTES, stored())
    const cb = vi.fn()
    const off = t.s.onChange(cb)

    off()
    await t.s.signOut()
    expect(cb).not.toHaveBeenCalled()
  })

  it('exposes token() as a live getter', async () => {
    // Precisely the shape openRepo(root, { token: () => session.token() }) will
    // hold, captured before sign-in, so a sign-in takes effect without rewiring.
    const t = await session(SIGN_IN_ROUTES)
    const getToken = () => t.s.token()

    expect(getToken()).toBeNull()
    await (await t.s.signIn()).wait()
    expect(getToken()).toBe(TOKEN)

    await t.s.signOut()
    expect(getToken()).toBeNull()
  })
})
