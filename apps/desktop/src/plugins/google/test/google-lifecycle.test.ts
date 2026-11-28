import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCapabilityHost } from '../../../main/capabilities/dispatch'
import { createCapabilityRegistry } from '../../../main/capabilities/registry'
import { install } from '../../../main/plugin-host/installed'
import { noCoreServices } from '../../../main/capabilities/services'
import { createPluginHost, type OpenVault } from '../../../main/plugin-host/host'
import type { MainPlugin, PluginCtx } from '../../../main/plugin-api'
import { writePluginSettings } from '../../../main/vault/settings'
import { createGoogleAccounts, type GoogleAccountsManager } from '../main/accounts'
import { createClientStore } from '../main/credentials'
import { createGoogleAccountsManager } from '../main/electron'
import { googleMain } from '../main/index'
import { GOOGLE_SCOPES } from '../main/session'
import { GoogleTokenStore } from '../main/token-store'
import { createVaultAccounts } from '../main/vault-accounts'
import { createMailMarkerStore } from '../main/markers'
import type { LoopbackServer } from '../main/loopback-flow'

vi.mock('../main/electron', () => ({ createGoogleAccountsManager: vi.fn() }))

const storage = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(`encrypted:${text}`),
  decryptString: (bytes: Buffer) => bytes.toString().replace(/^encrypted:/, ''),
}
const A = 'test/a'
const B = 'test/b'
const WINDOW = { from: '2026-11-13T00:00:00Z', to: '2026-11-14T00:00:00Z' }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

let dir: string
let stop: (() => Promise<void>) | undefined
let manager: GoogleAccountsManager
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>
let listen: ReturnType<typeof vi.fn<() => Promise<LoopbackServer>>>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holi-google-lifecycle-'))
  fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    const token = new Headers(init?.headers).get('Authorization') ?? ''
    const identity = token.endsWith('two') ? 'two' : 'one'
    if (url.includes('/token')) {
      const sub = new URLSearchParams(String(init?.body)).get('refresh_token')?.endsWith('two')
        ? 'two'
        : 'one'
      return Response.json({ access_token: `access-${sub}`, expires_in: 3600 })
    }
    if (url.includes('/revoke')) return Response.json({})
    if (url.includes('/calendarList'))
      return Response.json({ items: [{ id: 'primary', summary: identity, accessRole: 'owner' }] })
    if (url.includes('/calendars/'))
      return Response.json({
        items: [
          {
            id: identity,
            summary: identity,
            start: { dateTime: '2026-11-13T09:00:00Z' },
            end: { dateTime: '2026-11-13T10:00:00Z' },
          },
        ],
      })
    if (url.includes('/connections')) return Response.json({ connections: [] })
    throw new Error(`unexpected synthetic Google request: ${url}`)
  })
  vi.stubGlobal('fetch', fetcher)
  listen = vi.fn(async () => ({
    port: 1,
    waitForRedirect: () => new Promise(() => {}),
    close: vi.fn(),
  }))
  const store = new GoogleTokenStore(join(dir, 'auth.enc'), storage)
  await store.write(
    Object.fromEntries(
      ['one', 'two'].map((sub) => [
        sub,
        {
          sub,
          email: `${sub}@example.test`,
          refreshToken: `refresh-${sub}`,
          accessToken: `access-${sub}`,
          expiresAt: 0,
          scopes: [...GOOGLE_SCOPES],
        },
      ]),
    ),
  )
  const vaults = createVaultAccounts(join(dir, 'links.json'))
  await vaults.link(A, 'one')
  await vaults.link(B, 'two')
  manager = await createGoogleAccounts({
    store,
    vaults,
    clients: createClientStore(join(dir, 'client.enc'), storage),
    listen,
    openBrowser: async () => {},
    fetch: fetcher,
  })
  vi.mocked(createGoogleAccountsManager).mockReset().mockResolvedValue(manager)
})

afterEach(async () => {
  await stop?.()
  stop = undefined
  // Remove accounts through the production owner to close every SQLite handle.
  for (const remote of [A, B])
    for (const account of manager.list(remote)) await manager.removeAccount(remote, account.sub)
  vi.unstubAllGlobals()
  vi.useRealTimers()
  install([])
  await rm(dir, { recursive: true, force: true })
})

async function rig() {
  const roots: Record<string, string> = { [A]: join(dir, 'a'), [B]: join(dir, 'b') }
  await Promise.all(Object.values(roots).map((root) => mkdir(root)))
  const contexts = new Map<string, PluginCtx>()
  const google: MainPlugin = {
    ...googleMain,
    async activate(ctx) {
      contexts.set(ctx.remote, ctx)
      return googleMain.activate!(ctx)
    },
  }
  install([{ info: { id: 'agent', label: 'Agent', default: true, builtIn: true } }, google])
  const registry = createCapabilityRegistry()
  const host = createPluginHost({
    plugins: [google],
    registry,
    userData: dir,
    coreSeeds: [],
    active: () => null,
    rootFor: async (remote) => roots[remote] ?? null,
    events: { send: () => {}, listen: () => () => {}, liveRemote: () => null },
    openAppDoor: () => {
      throw new Error('no app door in this fixture')
    },
    route: () => () => {},
    binDir: () => '/unused',
    githubToken: () => null,
    frameOrigin: () => () => {},
    notify: () => false,
    focused: () => false,
  })
  const capabilities = createCapabilityHost({
    registry,
    rootFor: async (remote) => roots[remote] ?? null,
    get: (_remote) => null,
    core: noCoreServices,
    pluginEnabled: async (plugin, root) => (await host.serving(root)).has(plugin),
    claims: (root) => host.scanClaimsFor(root),
  })
  const vault = (remote: string): OpenVault => ({
    remote,
    root: roots[remote]!,
    pause: () => {},
    resume: () => {},
    drainSync: async () => {},
    commitNow: async () => null,
    repo: { head: async () => 'fixture' },
  })
  const enter = (remote: string) => host.reconcile(vault(remote), 'open')
  stop = () => host.stopAll()
  const call = async (remote: string, name: string, params: unknown = {}) =>
    (await capabilities.dispatch({ remote, name: `google.${name}`, params, door: 'ui' })).value
  return { host, enter, call, contexts, roots }
}

describe('production Google attachments in two explicit vault lifetimes', () => {
  it('keeps connection caches separate and B usable after A stops and restarts', async () => {
    const r = await rig()
    await Promise.all([r.enter(A), r.enter(B)])
    expect(r.host.failures(A)).toEqual({})
    expect(r.host.failures(B)).toEqual({})
    const [agenda, other] = await Promise.all([
      r.call(A, 'agenda', WINDOW),
      r.call(B, 'agenda', WINDOW),
    ])
    expect(agenda).toEqual([expect.objectContaining({ title: 'one' })])
    expect(other).toEqual([expect.objectContaining({ title: 'two' })])
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/token'))).toHaveLength(2)
    expect(await r.call(B, 'agendaCached', WINDOW)).toEqual(other)
    const cacheA = join(dir, `google-cache-${manager.list(A)[0]!.sub}.db`)
    expect(existsSync(cacheA)).toBe(true)
    expect(existsSync(join(dir, `google-cache-${manager.list(B)[0]!.sub}.db`))).toBe(true)
    await r.call(A, 'useAccount', { sub: manager.list(A)[0]!.sub })
    expect(await r.call(B, 'agendaCached', WINDOW)).toEqual(other)
    await r.host.stop(A)
    await r.host.stop(A)
    expect(await r.call(B, 'agendaCached', WINDOW)).toEqual(other)
    await r.enter(A)
    expect(await r.call(A, 'agendaCached', WINDOW)).toEqual(agenda)
  })

  it('preserves unlinked markers and purges only an owned connection', async () => {
    const subA = manager.list(A)[0]!.sub
    const subB = manager.list(B)[0]!.sub
    const one = createMailMarkerStore(dir, subA)
    const two = createMailMarkerStore(dir, subB)
    await one.set('thread-1', 'red-star')
    await one.setPreferences({ enabledOrder: ['red-star', 'blue-question'] })
    await two.set('thread-1', 'blue-question')
    const r = await rig()
    await Promise.all([r.enter(A), r.enter(B)])

    await r.call(A, 'disconnectVault')
    await expect(manager.removeAccount(A, subA)).rejects.toThrow()
    expect(await one.read(['thread-1'])).toEqual({ 'thread-1': 'red-star' })
    expect(await one.preferences()).toEqual({ enabledOrder: ['red-star', 'blue-question'] })
    expect(await r.call(B, 'agenda', WINDOW)).toEqual([expect.objectContaining({ title: 'two' })])

    await manager.removeAccount(B, subB)
    expect(await createMailMarkerStore(dir, subB).read(['thread-1'])).toEqual({ 'thread-1': null })
    expect(await createMailMarkerStore(dir, subB).preferences()).toEqual({
      enabledOrder: ['yellow-star'],
    })
    expect(await one.read(['thread-1'])).toEqual({ 'thread-1': 'red-star' })
    expect(await manager.sessionFor(B)).toBeNull()
  })

  it('isolates accounts and vault calendar settings', async () => {
    const r = await rig()
    await Promise.all([r.enter(A), r.enter(B)])
    expect(await r.call(A, 'agenda', WINDOW)).toEqual([expect.objectContaining({ title: 'one' })])
    expect(await r.call(B, 'agenda', WINDOW)).toEqual([expect.objectContaining({ title: 'two' })])
    await writePluginSettings(r.roots[A]!, 'google', { calendars: { primary: false } })
    expect(await r.call(A, 'agenda', WINDOW)).toEqual([])
    expect(await r.call(B, 'agenda', WINDOW)).toEqual([expect.objectContaining({ title: 'two' })])
  })

  it('stopping A never cancels the active consent owned by B', async () => {
    const r = await rig()
    await Promise.all([r.enter(A), r.enter(B)])
    await r.call(A, 'connect')
    const first = await listen.mock.results[0]!.value
    await r.call(B, 'connect')
    const second = await listen.mock.results[1]!.value
    expect(first.close).toHaveBeenCalled()
    await r.host.stop(A)
    expect(second.close).not.toHaveBeenCalled()
    await r.call(B, 'cancelConnect')
    expect(second.close).toHaveBeenCalledTimes(1)
  })

  it('cancels consent creation from a stopped activation without cancelling B', async () => {
    const r = await rig()
    await Promise.all([r.enter(A), r.enter(B)])
    const gate = deferred<LoopbackServer>()
    listen.mockImplementationOnce(() => gate.promise)
    const pending = r.call(A, 'connect')
    const rejected = expect(pending).rejects.toThrow(/stopped|no longer active/)
    await vi.waitFor(() => expect(listen).toHaveBeenCalledTimes(1))
    await r.host.stop(A)
    await r.call(B, 'connect')
    const second = await listen.mock.results[1]!.value
    const close = vi.fn()
    gate.resolve({ port: 1, waitForRedirect: () => new Promise(() => {}), close })
    await rejected
    expect(close).toHaveBeenCalled()
    expect(second.close).not.toHaveBeenCalled()
  })

  it('keeps B reads and polling alive when A stops, with events scoped to each account', async () => {
    const r = await rig()
    await Promise.all([r.enter(A), r.enter(B)])
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const eventsA: unknown[] = []
    const eventsB: unknown[] = []
    const ctxA = r.contexts.get(A)!
    const ctxB = r.contexts.get(B)!
    ctxA.events.on((event) => {
      if (event.type === 'upcoming') eventsA.push(event)
    })
    ctxB.events.on((event) => {
      if (event.type === 'upcoming') eventsB.push(event)
    })
    const interest = {
      type: 'interest' as const,
      interest: { task: false, calendar: true, mail: [] },
    }
    ctxA.events.emit(interest)
    ctxB.events.emit(interest)
    await vi.waitFor(() => expect(eventsA).toHaveLength(1))
    await vi.waitFor(() => expect(eventsB).toHaveLength(1))
    expect(eventsA[0]).toMatchObject({ moments: [expect.objectContaining({ id: 'one' })] })
    expect(eventsB[0]).toMatchObject({ moments: [expect.objectContaining({ id: 'two' })] })
    const original = fetcher.getMockImplementation()!
    const gate = deferred<Response>()
    const started = deferred<void>()
    fetcher.mockImplementation(async (url, init) => {
      if (String(url).includes('/calendars/')) {
        started.resolve()
        return gate.promise
      }
      return original(url, init)
    })
    const reading = r.call(B, 'agenda', WINDOW)
    await started.promise
    await r.host.stop(A)
    const countA = eventsA.length
    gate.resolve(Response.json({ items: [] }))
    await expect(reading).resolves.toEqual([])
    fetcher.mockImplementation(original)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await vi.waitFor(() => expect(eventsB).toHaveLength(2))
    expect(eventsA).toHaveLength(countA)
    expect(await r.call(B, 'status')).toMatchObject({ account: { email: 'two@example.test' } })
  })

  it('drops a late agenda result after removal and does not recreate its cache', async () => {
    const r = await rig()
    await Promise.all([r.enter(A), r.enter(B)])
    const original = fetcher.getMockImplementation()!
    const gate = deferred<Response>()
    const started = deferred<void>()
    fetcher.mockImplementation(async (url, init) => {
      if (String(url).includes('/calendars/')) {
        started.resolve()
        return gate.promise
      }
      return original(url, init)
    })
    const removedSub = manager.list(B)[0]!.sub
    const removedCache = join(dir, `google-cache-${removedSub}.db`)
    const pending = r.call(B, 'agenda', WINDOW)
    const rejected = expect(pending).rejects.toThrow(/no longer connected/)
    await started.promise
    await manager.removeAccount(B, manager.list(B)[0]!.sub)
    gate.resolve(Response.json({ items: [] }))
    await rejected
    expect(existsSync(removedCache)).toBe(false)
    expect(await r.call(A, 'status')).toMatchObject({ account: { email: 'one@example.test' } })
    expect(await r.call(B, 'status')).toMatchObject({ account: null })
  })

  it('awaits marker purge on removal and retires the cache even when purge fails', async () => {
    const r = await rig()
    await r.enter(A)
    const markerPath = join(dir, `google-mail-markers-${manager.list(A)[0]!.sub}.json`)
    await mkdir(markerPath)
    await writeFile(join(markerPath, 'blocked'), 'cannot remove the non-empty marker directory')
    const cachePath = join(dir, `google-cache-${manager.list(A)[0]!.sub}.db`)
    await Promise.all(
      ['', '-wal', '-shm', '-journal'].map((suffix) => writeFile(cachePath + suffix, 'old')),
    )

    await expect(manager.removeAccount(A, manager.list(A)[0]!.sub)).rejects.toThrow(
      /personal mail markers could not be deleted/,
    )
    for (const suffix of ['', '-wal', '-shm', '-journal'])
      expect(existsSync(cachePath + suffix)).toBe(false)
    expect(manager.list(A).some((account) => account.sub === 'one')).toBe(false)
  })

  it('deletes unopened persisted caches and all SQLite sidecars on removal', async () => {
    const r = await rig()
    await r.enter(A)
    const path = join(dir, `google-cache-${manager.list(A)[0]!.sub}.db`)
    await Promise.all(
      ['', '-wal', '-shm', '-journal'].map((suffix) => writeFile(path + suffix, 'old')),
    )
    await manager.removeAccount(A, manager.list(A)[0]!.sub)
    for (const suffix of ['', '-wal', '-shm', '-journal'])
      expect(existsSync(path + suffix)).toBe(false)
  })

  it('retries owner initialization after a failure without retaining a partial activation', async () => {
    const r = await rig()
    vi.mocked(createGoogleAccountsManager).mockRejectedValueOnce(new Error('keychain unavailable'))
    await r.enter(A)
    expect(r.host.failures(A)).toHaveProperty('google')
    await r.enter(A)
    expect(r.host.failures(A)).toEqual({})
    expect(createGoogleAccountsManager).toHaveBeenCalledTimes(2)
    expect(await r.call(A, 'status')).toMatchObject({ account: { email: 'one@example.test' } })
  })
})
