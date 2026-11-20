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
  name: 'Ada Holm',
  type: 'User',
}

const stored = (over: Partial<StoredAuth> = {}): StoredAuth => ({
  token: TOKEN,
  accountId: 583231,
  login: 'nthomsencph',
  name: 'Ada Holm',
  avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4',
  scopes: ['repo', 'read:user', 'read:org'],
  ...over,
})

/** A session over a real TokenStore in a tmpdir and a scripted network. */
async function session(
  routes: Record<string, Scripted[]>,
  seed?: StoredAuth,
  storageAdapter: SafeStorageLike = storage,
) {
  const store = new TokenStore(join(await scratch(), 'github-auth.enc'), storageAdapter)
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
    // Identity is cached for offline display, and a vault opens
    // with no network at all. So load() must not reach for the network — the
    // assertion is that it made no request, not that it recovered from one.
    const t = await session({}, stored())

    expect(t.s.viewer).toEqual({
      accountId: 583231,
      login: 'nthomsencph',
      name: 'Ada Holm',
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

  it('discards staged encrypted output when sign-out wins before publication', async () => {
    const t = await session(SIGN_IN_ROUTES)
    const originalPrepare = t.store.prepare.bind(t.store)
    let staged!: () => void
    let release!: () => void
    const stagedPromise = new Promise<void>((resolve) => (staged = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    vi.spyOn(t.store, 'prepare').mockImplementation(async (auth) => {
      const prepared = await originalPrepare(auth)
      staged()
      await gate
      return prepared
    })
    const flow = await t.s.signIn()
    const pending = flow.wait()
    await stagedPromise
    const signingOut = t.s.signOut()
    release()
    await signingOut
    await expect(pending).resolves.toEqual({ kind: 'cancelled' })
    expect(t.s.token()).toBeNull()
    expect(await t.store.read()).toBeNull()
  })

  it('preserves the current credential when the latest replacement fails', async () => {
    const previous = stored({ token: 'old-credential', accountId: 42, login: 'old-account' })
    const t = await session(SIGN_IN_ROUTES, previous)
    const originalPrepare = t.store.prepare.bind(t.store)
    vi.spyOn(t.store, 'prepare').mockImplementation(async (auth) => {
      const prepared = await originalPrepare(auth)
      return {
        publish: () => {
          throw new Error('replace failed')
        },
        discard: () => prepared.discard(),
      }
    })
    await expect((await t.s.signIn()).wait()).rejects.toThrow('replace failed')
    expect(t.s.token()).toBe('old-credential')
    expect(t.s.viewer?.accountId).toBe(42)
    expect((await t.store.read())?.token).toBe('old-credential')
  })

  it('does not adopt a credential when encrypted persistence fails and can retry', async () => {
    let available = true
    const adapter: SafeStorageLike = {
      ...storage,
      isEncryptionAvailable: () => available,
    }
    const previous = stored({ token: 'old-credential', accountId: 42, login: 'old-account' })
    const t = await session(SIGN_IN_ROUTES, previous, adapter)
    const previousFile = await t.store.read()
    const changes: (string | null)[] = []
    t.s.onChange((viewer) => changes.push(viewer?.login ?? null))
    available = false

    await expect((await t.s.signIn()).wait()).rejects.toMatchObject({
      name: 'EncryptionUnavailableError',
      phase: 'availability',
    })
    expect(t.s.token()).toBe('old-credential')
    expect(t.s.viewer?.accountId).toBe(42)
    expect(await t.store.read()).toEqual(previousFile)
    expect(changes).toEqual([])

    available = true
    await expect((await t.s.signIn()).wait()).resolves.toMatchObject({ kind: 'granted' })
    expect(t.s.token()).toBe(TOKEN)
    expect(t.s.viewer?.accountId).toBe(583231)
    expect(changes).toEqual(['nthomsencph'])
  })

  it('does not adopt a failed first credential', async () => {
    const unavailable: SafeStorageLike = { ...storage, isEncryptionAvailable: () => false }
    const t = await session(SIGN_IN_ROUTES, undefined, unavailable)
    await expect((await t.s.signIn()).wait()).rejects.toMatchObject({ phase: 'availability' })
    expect(t.s.token()).toBeNull()
    expect(t.s.viewer).toBeNull()
    expect(await t.store.read()).toBeNull()
  })

  it('does not adopt a stale viewer result after sign-out', async () => {
    let markViewerEntered!: () => void
    const viewerEntered = new Promise<void>((resolve) => (markViewerEntered = resolve))
    let resolveViewer!: (response: Response) => void
    const viewerResponse = new Promise<Response>((resolve) => {
      resolveViewer = resolve
    })
    const scripted = fakeNet({
      '/login/device/code': [{ body: CODE }],
      '/login/oauth/access_token': [{ body: GRANT }],
    })
    const fetch = (async (input: unknown) => {
      if (new URL(String(input)).pathname === '/user') {
        markViewerEntered()
        return viewerResponse
      }
      return scripted.fetch(input)
    }) as typeof globalThis.fetch
    const store = new TokenStore(join(await scratch(), 'github-auth.enc'), storage)
    const s = await GitHubSession.load({ store, fetch, sleep: async () => {} })
    const flow = await s.signIn()
    const pendingAdoption = flow.wait()
    await viewerEntered

    await s.signOut()
    resolveViewer(
      new Response(JSON.stringify(VIEWER), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await expect(pendingAdoption).resolves.toEqual({ kind: 'cancelled' })

    expect(s.token()).toBeNull()
    expect(s.viewer).toBeNull()
    expect(await store.read()).toBeNull()
  })

  it('memoizes the complete wait promise', async () => {
    const t = await session(SIGN_IN_ROUTES)
    const flow = await t.s.signIn()
    const first = flow.wait()
    expect(flow.wait()).toBe(first)
    await expect(first).resolves.toMatchObject({ kind: 'granted' })
  })

  it('cancels a grant when sign-out happens before polling starts', async () => {
    const t = await session(SIGN_IN_ROUTES)
    const flow = await t.s.signIn()
    await t.s.signOut()
    await expect(flow.wait()).resolves.toEqual({ kind: 'cancelled' })
    expect(t.s.token()).toBeNull()
    expect(await t.store.read()).toBeNull()
  })

  it('cancels the previous sign-in when a newer attempt begins', async () => {
    const t = await session(SIGN_IN_ROUTES)
    const old = await t.s.signIn()
    const newer = t.s.signIn()
    await expect(old.wait()).resolves.toEqual({ kind: 'cancelled' })
    await expect((await newer).wait()).resolves.toMatchObject({ kind: 'granted' })
  })

  it('does not adopt a viewer after its attempt is cancelled in flight', async () => {
    let markViewerEntered!: () => void
    const viewerEntered = new Promise<void>((resolve) => (markViewerEntered = resolve))
    let resolveViewer!: (response: Response) => void
    const viewerResponse = new Promise<Response>((resolve) => (resolveViewer = resolve))
    const scripted = fakeNet({
      '/login/device/code': [{ body: CODE }],
      '/login/oauth/access_token': [{ body: GRANT }],
    })
    const fetch = (async (input: unknown) => {
      if (new URL(String(input)).pathname === '/user') {
        markViewerEntered()
        return viewerResponse
      }
      return scripted.fetch(input)
    }) as typeof globalThis.fetch
    const store = new TokenStore(join(await scratch(), 'github-auth.enc'), storage)
    const s = await GitHubSession.load({ store, fetch, sleep: async () => {} })
    const flow = await s.signIn()
    const pending = flow.wait()
    await viewerEntered
    flow.cancel()
    resolveViewer(
      new Response(JSON.stringify(VIEWER), { headers: { 'content-type': 'application/json' } }),
    )
    await expect(pending).resolves.toEqual({ kind: 'cancelled' })
    expect(s.token()).toBeNull()
    expect(await store.read()).toBeNull()
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
    // Deleting someone's files — which may hold unpushed commits — is
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

  it('does not let an old credential 401 sign out a newly adopted credential', async () => {
    let resolveResponse!: (response: Response) => void
    const staleResponse = new Promise<Response>((resolve) => (resolveResponse = resolve))
    const scripted = fakeNet({
      ...SIGN_IN_ROUTES,
      '/user/repos': [{ status: 200, body: [] }],
    })
    const fetch = (async (input: unknown) =>
      new URL(String(input)).pathname === '/user/repos'
        ? staleResponse
        : scripted.fetch(input)) as typeof globalThis.fetch
    const store = new TokenStore(join(await scratch(), 'github-auth.enc'), storage)
    await store.write(stored({ token: 'old-credential' }))
    const s = await GitHubSession.load({ store, fetch, sleep: async () => {} })
    const pendingRequest = s.api.repos()
    await (await s.signIn()).wait()
    resolveResponse(new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }))
    await expect(pendingRequest).rejects.toMatchObject({ kind: 'unauthorized' })
    expect(s.token()).toBe(TOKEN)
    expect(await store.read()).toMatchObject({ token: TOKEN })
  })

  it('does not let an old same-token request sign out a revalidated session', async () => {
    let resolveResponse!: (response: Response) => void
    const staleResponse = new Promise<Response>((resolve) => (resolveResponse = resolve))
    const scripted = fakeNet({
      ...SIGN_IN_ROUTES,
      '/user/repos': [{ status: 200, body: [] }],
    })
    const fetch = (async (input: unknown) =>
      new URL(String(input)).pathname === '/user/repos'
        ? staleResponse
        : scripted.fetch(input)) as typeof globalThis.fetch
    const store = new TokenStore(join(await scratch(), 'github-auth.enc'), storage)
    await store.write(stored())
    const s = await GitHubSession.load({ store, fetch, sleep: async () => {} })
    const pendingRequest = s.api.repos()

    // The same bearer can be validated again and adopted as a new credential
    // instance; a delayed 401 from its earlier use must not erase that result.
    await expect((await s.signIn()).wait()).resolves.toMatchObject({ kind: 'granted' })
    resolveResponse(new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }))
    await expect(pendingRequest).rejects.toMatchObject({ kind: 'unauthorized' })
    expect(s.token()).toBe(TOKEN)
    expect(s.viewer?.accountId).toBe(583231)
    expect(await store.read()).toMatchObject({ token: TOKEN, accountId: 583231 })
  })

  it('does not cancel an independent replacement candidate on the old credential 401', async () => {
    let resolveViewer!: (response: Response) => void
    const viewerResponse = new Promise<Response>((resolve) => (resolveViewer = resolve))
    let resolveUnauthorized!: (response: Response) => void
    const unauthorizedResponse = new Promise<Response>((resolve) => (resolveUnauthorized = resolve))
    const scripted = fakeNet(SIGN_IN_ROUTES)
    const fetch = (async (input: unknown) => {
      const path = new URL(String(input)).pathname
      if (path === '/user/repos') return unauthorizedResponse
      if (path === '/user') return viewerResponse
      return scripted.fetch(input)
    }) as typeof globalThis.fetch
    const store = new TokenStore(join(await scratch(), 'github-auth.enc'), storage)
    await store.write(stored({ token: 'old-credential' }))
    const originalPrepare = store.prepare.bind(store)
    let staged!: () => void
    let release!: () => void
    const stagedPromise = new Promise<void>((resolve) => (staged = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    vi.spyOn(store, 'prepare').mockImplementation(async (auth) => {
      const prepared = await originalPrepare(auth)
      staged()
      await gate
      return prepared
    })
    const s = await GitHubSession.load({ store, fetch, sleep: async () => {} })
    const oldRequest = s.api.repos()
    const candidate = (await s.signIn()).wait()
    await Promise.resolve()
    resolveViewer(
      new Response(JSON.stringify(VIEWER), { headers: { 'content-type': 'application/json' } }),
    )
    await stagedPromise
    resolveUnauthorized(
      new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }),
    )
    release()
    await expect(oldRequest).rejects.toMatchObject({ kind: 'unauthorized' })
    await expect(candidate).resolves.toMatchObject({ kind: 'granted' })
    expect(s.token()).toBe(TOKEN)
    expect(await store.read()).toMatchObject({ token: TOKEN })
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

  it('announces generation invalidation synchronously before sign-out storage work', async () => {
    const t = await session(SIGN_IN_ROUTES, stored())
    let invalidated = false
    t.s.onGenerationChange(() => {
      invalidated = true
    })
    const signingOut = t.s.signOut()
    expect(invalidated).toBe(true)
    await signingOut
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
