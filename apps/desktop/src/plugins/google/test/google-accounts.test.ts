/**
 * `createGoogleAccounts` — the owner of the token store, and the one place that
 * turns a vault into a session.
 *
 * The properties worth protecting here are the ones a happy path hides: that two
 * vaults on one account share ONE session (so they share its single-flight
 * refresh latch), that unlinking a vault is not a disconnect, and that removing
 * an account takes every vault pointing at it down with it.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGoogleAccounts, type GoogleAccountsManager } from '../main/accounts'
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  resolveClient,
  type GoogleClient,
  type GoogleClientStore,
  createClientStore,
} from '../main/credentials'
import { createVaultAccounts } from '../main/vault-accounts'
import { GoogleTokenStore, type StoredGoogleAuth } from '../main/token-store'
import type { LoopbackServer } from '../main/loopback-flow'
import { GOOGLE_SCOPES } from '../main/session'
import { GoogleApi } from '../main/api'

const storage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(`enc:${plain}`),
  decryptString: (buf: Buffer) => buf.toString().replace(/^enc:/, ''),
}

const NOW = 1_000_000
const VAULT = 'nthomsencph/privat'
const WORK = 'syv/krifa'

let dir: string
let store: GoogleTokenStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holi-google-accounts-'))
  store = new GoogleTokenStore(join(dir, 'google-auth.enc'), storage)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function auth(overrides: Partial<StoredGoogleAuth> = {}): StoredGoogleAuth {
  return {
    sub: 'sub-1',
    email: 'ada@syv.ai',
    refreshToken: 'rt-1',
    accessToken: 'at-1',
    expiresAt: NOW + 3_600_000,
    scopes: ['openid'],
    ...overrides,
  }
}

/** This machine's own client, held in memory. */
function memoryClients(initial: GoogleClient | null): GoogleClientStore {
  let held = initial
  return {
    read: async () => held,
    write: async (client) => {
      held = client
    },
  }
}

async function manager(seed: StoredGoogleAuth[] = [], fetchImpl?: typeof globalThis.fetch) {
  if (seed.length > 0) {
    await store.write(Object.fromEntries(seed.map((a) => [a.sub, a])))
  }
  return createGoogleAccounts({
    store,
    vaults: createVaultAccounts(join(dir, 'google-vault-accounts.json')),
    listen: async (): Promise<LoopbackServer> => ({
      port: 1,
      waitForRedirect: () => new Promise(() => {}),
      close: () => {},
    }),
    openBrowser: async () => {},
    clients: memoryClients({ id: 'client-1' }),
    fetch: fetchImpl,
    now: () => NOW,
  })
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

/** Independently gated code exchanges and refresh, with real persistence. */
async function controlledConsent(seed: StoredGoogleAuth[] = []) {
  await store.write(Object.fromEntries(seed.map((row) => [row.sub, row])))
  let now = NOW
  const states = new Map<string, string>()
  const exchanges: Array<{
    started: ReturnType<typeof deferred<void>>
    reply: ReturnType<typeof deferred<StoredGoogleAuth>>
  }> = []
  const revoked: string[] = []
  const refreshes: string[] = []
  const refreshStarted = deferred<void>()
  const refreshReply = deferred<Response>()
  const accounts = await createGoogleAccounts({
    store,
    vaults: createVaultAccounts(join(dir, 'google-vault-accounts.json')),
    clients: memoryClients(null),
    env: {},
    now: () => now,
    listen: async () => {
      const index = exchanges.length
      const port = 45123 + index
      exchanges.push({ started: deferred<void>(), reply: deferred<StoredGoogleAuth>() })
      return {
        port,
        waitForRedirect: async () => ({ code: String(index), state: states.get(String(port))! }),
        close: () => {},
      }
    },
    openBrowser: async (url) => {
      const params = new URL(url).searchParams
      states.set(new URL(params.get('redirect_uri')!).port, params.get('state')!)
    },
    fetch: (async (url, init) => {
      const params = new URLSearchParams(String(init?.body))
      if (String(url).endsWith('/revoke')) {
        revoked.push(params.get('token')!)
        return new Response('{}')
      }
      if (params.get('grant_type') === 'refresh_token') {
        refreshes.push(params.get('refresh_token')!)
        refreshStarted.resolve()
        return refreshReply.promise
      }
      const exchange = exchanges[Number(params.get('code'))]!
      exchange.started.resolve()
      const row = await exchange.reply.promise
      return new Response(
        JSON.stringify({
          access_token: row.accessToken,
          refresh_token: row.refreshToken,
          expires_in: (row.expiresAt - now) / 1000,
          scope: row.scopes.join(' '),
          id_token: `header.${Buffer.from(JSON.stringify({ sub: row.sub, email: row.email })).toString('base64url')}.signature`,
        }),
      )
    }) as typeof globalThis.fetch,
  })
  return {
    accounts,
    exchanges,
    revoked,
    refreshes,
    refreshStarted,
    refreshReply,
    setNow: (value: number) => {
      now = value
    },
  }
}

describe('sessionFor', () => {
  it('is null for a vault that has never connected, and does not throw', async () => {
    // "Not connected" is a state the UI already renders; it is not an error.
    const accounts = await manager([auth()])
    expect(await accounts.sessionFor(VAULT)).toBeNull()
  })

  it('is null for a vault linked to an account that is no longer stored', async () => {
    const accounts = await manager([auth()])
    await accounts.link(VAULT, 'sub-1')
    await accounts.removeAccount('sub-1')
    expect(await accounts.sessionFor(VAULT)).toBeNull()
  })

  it('gives two vaults on one account the SAME session', async () => {
    // Not an optimisation: `#refreshing` is a per-account single-flight latch,
    // and two sessions over one account would race the rotating refresh token.
    const accounts = await manager([auth()])
    await accounts.link(VAULT, 'sub-1')
    await accounts.link(WORK, 'sub-1')

    expect(await accounts.sessionFor(VAULT)).toBe(await accounts.sessionFor(WORK))
  })

  it('gives two vaults on two accounts different sessions', async () => {
    const accounts = await manager([auth(), auth({ sub: 'sub-2', email: 'work@syv.ai' })])
    await accounts.link(VAULT, 'sub-1')
    await accounts.link(WORK, 'sub-2')

    const mine = await accounts.sessionFor(VAULT)
    const theirs = await accounts.sessionFor(WORK)
    expect(mine).not.toBe(theirs)
    expect(mine!.account?.email).toBe('ada@syv.ai')
    expect(theirs!.account?.email).toBe('work@syv.ai')
  })
})

describe('list', () => {
  it('names every connected account', async () => {
    const accounts = await manager([auth(), auth({ sub: 'sub-2', email: 'work@syv.ai' })])
    expect(accounts.list()).toEqual([
      { sub: 'sub-1', email: 'ada@syv.ai' },
      { sub: 'sub-2', email: 'work@syv.ai' },
    ])
  })
})

describe('overview', () => {
  it("names this vault's account, its state and a count of its other vaults, never their names", async () => {
    const accounts = await manager([
      auth({ scopes: [...GOOGLE_SCOPES] }),
      auth({ sub: 'sub-2', email: 'work@syv.ai' }),
    ])
    await accounts.link(VAULT, 'sub-1')
    await accounts.link(WORK, 'sub-1')
    const overview = await accounts.overview(VAULT)
    expect(overview).toMatchObject({
      remote: VAULT,
      state: 'connected',
      account: { sub: 'sub-1', email: 'ada@syv.ai', missingScopes: [], otherVaults: 1 },
      client: { id: 'client-1', source: 'own' },
    })
    expect(JSON.stringify(overview)).not.toContain(WORK)
    expect(JSON.stringify(overview)).not.toContain('work@syv.ai')
  })

  it('says which scopes a grant lacks', async () => {
    const accounts = await manager([auth()])
    await accounts.link(VAULT, 'sub-1')
    const overview = await accounts.overview(VAULT)
    expect(overview.state).toBe('missing-scope')
    expect(overview.account?.missingScopes.length).toBeGreaterThan(0)
  })

  it('needs reconnecting when the linked account is gone, and is not connected when never linked', async () => {
    const accounts = await manager([auth()])
    expect(await accounts.overview(VAULT)).toMatchObject({ state: 'not-connected', account: null })
    await accounts.link(VAULT, 'sub-1')
    await store.write({})
    const gone = await manager()
    expect(await gone.overview(VAULT)).toMatchObject({ state: 'needs-reconnect', account: null })
  })
})

describe('a grant Google refuses', () => {
  const refused = vi.fn(async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: 'invalid_grant' }),
    text: async () => '{"error":"invalid_grant"}',
  })) as unknown as typeof globalThis.fetch

  it('leaves the vault needing a reconnect until it links again or lets go', async () => {
    const accounts = await manager([auth({ expiresAt: NOW - 1 })], refused)
    await accounts.link(VAULT, 'sub-1')
    const changed = vi.fn()
    accounts.onChange(changed)
    const session = await accounts.sessionFor(VAULT)

    await expect(session!.getAccessToken()).rejects.toThrow(/expired or been revoked/)

    expect(changed).toHaveBeenCalledWith('sub-1')
    expect(await accounts.sessionFor(VAULT)).toBeNull()
    expect(accounts.list()).toEqual([])
    expect(await accounts.overview(VAULT)).toMatchObject({
      state: 'needs-reconnect',
      account: null,
    })

    // The same account connected elsewhere does not hand this vault its mailbox.
    const again = await manager([auth()])
    expect(await again.sessionFor(VAULT)).toBeNull()
    expect(await again.overview(VAULT)).toMatchObject({ state: 'needs-reconnect' })

    await again.link(VAULT, 'sub-1')
    expect((await again.overview(VAULT)).state).not.toBe('needs-reconnect')
    await again.unlinkVault(VAULT)
    expect(await again.overview(VAULT)).toMatchObject({ state: 'not-connected' })
  })

  it('stops needing a reconnect when the vault lets go', async () => {
    const accounts = await manager([auth({ expiresAt: NOW - 1 })], refused)
    await accounts.link(VAULT, 'sub-1')
    await (await accounts.sessionFor(VAULT))!.getAccessToken().catch(() => undefined)

    await accounts.unlinkVault(VAULT)

    expect(await accounts.overview(VAULT)).toMatchObject({ state: 'not-connected' })
  })

  it('stops needing a reconnect when an account already refused is removed', async () => {
    const accounts = await manager([auth({ expiresAt: NOW - 1 })], refused)
    await accounts.link(VAULT, 'sub-1')
    await (await accounts.sessionFor(VAULT))!.getAccessToken().catch(() => undefined)

    await accounts.removeAccount('sub-1')

    expect(await accounts.overview(VAULT)).toMatchObject({ state: 'not-connected' })
  })

  it('is not left needing a reconnect when a removal overlaps the refusal', async () => {
    const vaults = createVaultAccounts(join(dir, 'overlap.json'))
    await vaults.link(VAULT, 'sub-1')

    await Promise.all([vaults.expireAccount('sub-1'), vaults.unlinkAccount('sub-1')])

    expect(await vaults.needsReconnect(VAULT)).toBe(false)
  })

  it('is not left needing a reconnect when the grant dies during a removal', async () => {
    let session: Awaited<ReturnType<GoogleAccountsManager['sessionFor']>> = null
    const dying = vi.fn(async (url: string) => {
      if (String(url).includes('revoke')) {
        await session!.getAccessToken().catch(() => undefined)
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
      }
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_grant' }),
        text: async () => '{"error":"invalid_grant"}',
      }
    }) as unknown as typeof globalThis.fetch
    const accounts = await manager([auth({ expiresAt: NOW - 1 })], dying)
    await accounts.link(VAULT, 'sub-1')
    session = await accounts.sessionFor(VAULT)

    await accounts.removeAccount('sub-1')

    expect(await accounts.overview(VAULT)).toMatchObject({ state: 'not-connected' })
  })
})

describe('link', () => {
  it('refuses an account that is not in the store', async () => {
    // A dangling mapping would resolve to null forever and look like a bug in
    // the connection rather than in the link.
    const accounts = await manager([auth()])
    await expect(accounts.link(VAULT, 'sub-nope')).rejects.toThrow(/not connected/i)
  })
})

describe('unlinkVault', () => {
  it('is not a disconnect: the account stays and other vaults keep working', async () => {
    const accounts = await manager([auth()])
    await accounts.link(VAULT, 'sub-1')
    await accounts.link(WORK, 'sub-1')

    await accounts.unlinkVault(VAULT)

    expect(await accounts.sessionFor(VAULT)).toBeNull()
    expect(await accounts.sessionFor(WORK)).not.toBeNull()
    expect(accounts.list()).toHaveLength(1)
    expect(await store.read()).not.toEqual({})
  })
})

describe('removeAccount', () => {
  it('revokes at Google, drops the record, and unlinks every vault using it', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const accounts = await manager(
      [auth(), auth({ sub: 'sub-2', email: 'work@syv.ai' })],
      fetchImpl as unknown as typeof globalThis.fetch,
    )
    await accounts.link(VAULT, 'sub-1')
    await accounts.link(WORK, 'sub-1')
    await accounts.link('a/third', 'sub-2')

    await accounts.removeAccount('sub-1')

    expect(fetchImpl).toHaveBeenCalled()
    expect(accounts.list()).toEqual([{ sub: 'sub-2', email: 'work@syv.ai' }])
    expect(await accounts.sessionFor(VAULT)).toBeNull()
    expect(await accounts.sessionFor(WORK)).toBeNull()
    expect(await accounts.sessionFor('a/third')).not.toBeNull()
  })
})

describe('onChange', () => {
  it('names the account that changed, so a cache can be scoped to it', async () => {
    const seen: (string | null)[] = []
    const accounts = await manager(
      [auth()],
      (async () => new Response('{}', { status: 200 })) as unknown as typeof globalThis.fetch,
    )
    accounts.onChange((sub) => seen.push(sub))

    await accounts.link(VAULT, 'sub-1')
    await accounts.removeAccount('sub-1')

    expect(seen).toContain('sub-1')
  })
})

describe('the client credentials', () => {
  /**
   * `electron.ts` builds the manager with an empty own-client store, so the
   * client comes from the resolver. Every rig above sets its own client, which
   * is exactly how an empty-string fallback once shipped: consent died at
   * Google with `Missing required parameter: client_id` before the user ever
   * saw a consent screen.
   *
   * So this builds the manager the way production does, and asserts both halves.
   * The secret is the half that fails later and reads differently — at the token
   * exchange, after consent has already been given.
   */
  async function productionManager(
    exchange: { calls: Array<Record<string, string>> },
    clients: GoogleClientStore = memoryClients(null),
  ) {
    let state = ''
    return createGoogleAccounts({
      store,
      vaults: createVaultAccounts(join(dir, 'google-vault-accounts.json')),
      clients,
      // Not the shell's: a developer's HOLI_GOOGLE_CLIENT_ID must not decide it.
      env: {},
      listen: async () => ({
        port: 45123,
        // Echoes back whatever state the authorization URL carried, so the
        // exchange is reached without hardcoding a state the flow invented.
        waitForRedirect: async () => ({ code: 'auth-code', state }),
        close: () => {},
      }),
      openBrowser: async (url) => {
        state = new URL(url).searchParams.get('state') ?? ''
      },
      fetch: (async (_url: string, init: RequestInit) => {
        exchange.calls.push(Object.fromEntries(new URLSearchParams(String(init.body)).entries()))
        return {
          ok: true,
          json: async () => ({
            access_token: 'at-1',
            refresh_token: 'rt-1',
            expires_in: 3600,
            scope: 'openid email',
            id_token: `header.${Buffer.from(
              JSON.stringify({ sub: 'sub-9', email: 'ada@syv.ai' }),
            ).toString('base64url')}.signature`,
          }),
          text: async () => '',
        }
      }) as unknown as typeof globalThis.fetch,
      now: () => NOW,
    })
  }

  it('sends the embedded client id when the wiring passes none', async () => {
    const exchange = { calls: [] as Array<Record<string, string>> }
    const accounts = await productionManager(exchange)

    const flow = await accounts.connect(VAULT)

    expect(new URL(flow.authUrl).searchParams.get('client_id')).toBe(GOOGLE_CLIENT_ID)
  })

  it('sends the embedded client secret on the token exchange', async () => {
    const exchange = { calls: [] as Array<Record<string, string>> }
    const accounts = await productionManager(exchange)

    const flow = await accounts.connect(VAULT)
    await flow.wait()

    expect(exchange.calls[0]?.client_secret).toBe(GOOGLE_CLIENT_SECRET)
  })

  it('connects with this machine’s own client once one is set', async () => {
    const exchange = { calls: [] as Array<Record<string, string>> }
    const accounts = await productionManager(exchange)

    await accounts.setClient({ id: 'own.apps.googleusercontent.com', secret: 'own-secret' })
    const flow = await accounts.connect(VAULT)
    await flow.wait()

    expect(accounts.client()).toEqual({ id: 'own.apps.googleusercontent.com', source: 'own' })
    expect(new URL(flow.authUrl).searchParams.get('client_id')).toBe(
      'own.apps.googleusercontent.com',
    )
    expect(exchange.calls[0]?.client_secret).toBe('own-secret')
  })

  it('serializes simultaneous replacements through the encrypted client store', async () => {
    const clients = createClientStore(join(dir, 'google-client.enc'), storage)
    const accounts = await productionManager({ calls: [] }, clients)
    const one = { id: 'one.apps.googleusercontent.com', secret: 'one-secret' }
    const two = { id: 'two.apps.googleusercontent.com', secret: 'two-secret' }

    await Promise.all([accounts.setClient(one), accounts.setClient(two)])

    expect(accounts.client()).toEqual({ id: two.id, source: 'own' })
    expect(await clients.read()).toEqual(two)
  })

  it('removes every account, revoking each, when the client changes', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const accounts = await manager(
      [auth(), auth({ sub: 'sub-2', email: 'work@syv.ai' })],
      fetchImpl as unknown as typeof globalThis.fetch,
    )
    await accounts.link(VAULT, 'sub-1')
    await accounts.link(WORK, 'sub-2')
    const changed: (string | null)[] = []
    accounts.onChange((sub) => changed.push(sub))

    await accounts.setClient({ id: 'other.apps.googleusercontent.com', secret: 's' })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(accounts.list()).toEqual([])
    expect(await accounts.sessionFor(VAULT)).toBeNull()
    expect(await accounts.sessionFor(WORK)).toBeNull()
    // Each one named, so its cache is deleted with it.
    expect(changed).toEqual(['sub-1', 'sub-2'])
    expect(await store.read()).toEqual({})
  })

  it('keeps every account when the same client is saved again', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const accounts = await manager([auth()], fetchImpl as unknown as typeof globalThis.fetch)

    await accounts.setClient({ id: 'client-1' })

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(accounts.list()).toHaveLength(1)
  })
})

describe('a grant that lands after it was let go', () => {
  it('keeps a later consent flow when an earlier listener is created asynchronously', async () => {
    let releaseFirst!: (server: LoopbackServer) => void
    let releaseSecond!: (server: LoopbackServer) => void
    let listeners = 0
    let firstListening!: () => void
    let secondListening!: () => void
    const atFirstListen = new Promise<void>((resolve) => (firstListening = resolve))
    const atSecondListen = new Promise<void>((resolve) => (secondListening = resolve))
    let firstClosed = 0
    let secondClosed = 0
    const server = (which: number): LoopbackServer => ({
      port: 45123 + which,
      waitForRedirect: () => new Promise(() => {}),
      close: () => {
        if (which === 1) firstClosed += 1
        else secondClosed += 1
      },
    })
    const accounts = await createGoogleAccounts({
      store,
      vaults: createVaultAccounts(join(dir, 'google-vault-accounts.json')),
      clients: memoryClients(null),
      env: {},
      listen: () => {
        listeners += 1
        return new Promise<LoopbackServer>((resolve) => {
          if (listeners === 1) {
            releaseFirst = resolve
            firstListening()
          } else {
            releaseSecond = resolve
            secondListening()
          }
        })
      },
      openBrowser: async () => {},
      fetch: (async () => new Response('{}')) as unknown as typeof globalThis.fetch,
      now: () => NOW,
    })

    const earlierPromise = accounts.connect(VAULT)
    await atFirstListen
    accounts.cancelConnect()
    const laterPromise = accounts.connect(WORK)
    await atSecondListen
    releaseSecond(server(2))
    const later = await laterPromise
    releaseFirst(server(1))
    const earlier = await earlierPromise

    earlier.cancel()
    expect(firstClosed).toBe(1)
    expect(secondClosed).toBe(0)
    accounts.cancelConnect()
    expect(secondClosed).toBe(1)
    later.cancel()
  })

  const TOKEN_URL = 'https://oauth2.googleapis.com/token'
  const REVOKE = 'https://oauth2.googleapis.com/revoke'

  /**
   * A connect whose code exchange hangs until `release`, the moment a cancel
   * or a client change cannot stop: the request is already at Google.
   */
  async function hangingExchange() {
    let state = ''
    let release = () => {}
    let exchanging = () => {}
    const atGoogle = new Promise<void>((resolve) => (exchanging = resolve))
    const revoked: string[] = []
    const accounts = await createGoogleAccounts({
      store,
      vaults: createVaultAccounts(join(dir, 'google-vault-accounts.json')),
      clients: memoryClients(null),
      env: {},
      listen: async () => ({
        port: 45123,
        waitForRedirect: async () => ({ code: 'auth-code', state }),
        close: () => {},
      }),
      openBrowser: async (url) => {
        state = new URL(url).searchParams.get('state') ?? ''
      },
      fetch: (async (url: string, init: RequestInit) => {
        const body = new URLSearchParams(String(init.body))
        if (url === REVOKE) {
          revoked.push(body.get('token') ?? '')
          return new Response('{}', { status: 200 })
        }
        expect(url).toBe(TOKEN_URL)
        exchanging()
        await new Promise<void>((resolve) => (release = resolve))
        return new Response(
          JSON.stringify({
            access_token: 'at-new',
            refresh_token: 'rt-new',
            expires_in: 3600,
            scope: 'openid email',
            id_token: `header.${Buffer.from(
              JSON.stringify({ sub: 'sub-9', email: 'ada@syv.ai' }),
            ).toString('base64url')}.signature`,
          }),
          { status: 200 },
        )
      }) as unknown as typeof globalThis.fetch,
      now: () => NOW,
    })
    return { accounts, revoked, atGoogle, release: () => release() }
  }

  it('revokes the grant of a connect cancelled during the exchange, and keeps nothing', async () => {
    const rig = await hangingExchange()
    const flow = await rig.accounts.connect(VAULT)
    const outcome = flow.wait()
    await rig.atGoogle

    rig.accounts.cancelConnect()
    rig.release()

    expect(await outcome).toEqual({ kind: 'cancelled' })
    expect(rig.revoked).toEqual(['rt-new'])
    expect(rig.accounts.list()).toEqual([])
    expect(await rig.accounts.sessionFor(VAULT)).toBeNull()
  })

  it('discards consent whose token write was already queued when the client changed', async () => {
    const rig = await hangingExchange()
    const originalWrite = store.write.bind(store)
    let releaseWrite!: () => void
    let writeStarted!: () => void
    const atWrite = new Promise<void>((resolve) => (writeStarted = resolve))
    let gated = false
    store.write = async (value) => {
      if (!gated) {
        gated = true
        writeStarted()
        await new Promise<void>((resolve) => (releaseWrite = resolve))
      }
      await originalWrite(value)
    }
    const flow = await rig.accounts.connect(VAULT)
    const outcome = flow.wait()
    await rig.atGoogle
    rig.release()
    await atWrite

    await rig.accounts.setClient({ id: 'replacement.apps.googleusercontent.com', secret: 's' })
    releaseWrite()

    expect(await outcome).toEqual({ kind: 'cancelled' })
    expect(rig.accounts.list()).toEqual([])
    expect(await store.read()).toEqual({})
    expect(rig.revoked).toEqual(['rt-new'])
  })

  it('revokes the grant of a connect overtaken by a client change', async () => {
    const rig = await hangingExchange()
    const flow = await rig.accounts.connect(VAULT)
    const outcome = flow.wait()
    await rig.atGoogle

    await rig.accounts.setClient({ id: 'own.apps.googleusercontent.com', secret: 's' })
    rig.release()

    expect(await outcome).toEqual({ kind: 'cancelled' })
    expect(rig.revoked).toEqual(['rt-new'])
    expect(rig.accounts.list()).toEqual([])
  })

  it('does not accept consent for an account removed before it was stored', async () => {
    const rig = await hangingExchange()
    const flow = await rig.accounts.connect(VAULT)
    const outcome = flow.wait()
    await rig.atGoogle

    await rig.accounts.removeAccount('sub-9')
    rig.release()

    expect(await outcome).toEqual({ kind: 'cancelled' })
    expect(rig.revoked).toEqual(['rt-new'])
    expect(rig.accounts.list()).toEqual([])
    expect(await store.read()).toEqual({})
  })

  it('removes a first grant whose storage write already started, even while its row is absent', async () => {
    const rig = await hangingExchange()
    const vaults = createVaultAccounts(join(dir, 'google-vault-accounts.json'))
    const originalWrite = store.write.bind(store)
    const atWrite = deferred<void>()
    const releaseWrite = deferred<void>()
    let gated = false
    vi.spyOn(store, 'write').mockImplementation(async (value) => {
      if (!gated) {
        gated = true
        atWrite.resolve()
        await releaseWrite.promise
      }
      await originalWrite(value)
    })
    const flow = await rig.accounts.connect(VAULT)
    const outcome = flow.wait()
    await rig.atGoogle
    rig.release()
    await atWrite.promise
    expect(rig.accounts.list()).toEqual([])

    const removal = rig.accounts.removeAccount('sub-9')
    releaseWrite.resolve()

    await removal
    expect(await outcome).toEqual({ kind: 'cancelled' })
    expect(rig.accounts.list()).toEqual([])
    expect(await store.read()).toEqual({})
    expect(await vaults.all()).toEqual({})
    expect(rig.revoked).toEqual(['rt-new'])
  })

  it.each(['rt-1', 'rt-replacement'])(
    'never lends a reconnected grant (%s) to a retained session, even for a refresh',
    async (refreshToken) => {
      const rig = await controlledConsent([auth()])
      await rig.accounts.link(VAULT, 'sub-1')
      const old = rig.accounts.sessionForSub('sub-1')!
      const flow = await rig.accounts.connect(WORK)
      const outcome = flow.wait()
      await rig.exchanges[0]!.started.promise
      rig.exchanges[0]!.reply.resolve(auth({ refreshToken, accessToken: 'at-replacement' }))
      expect((await outcome).kind).toBe('granted')

      expect(old.account).toBeNull()
      await expect(old.getAccessToken()).rejects.toThrow(/expired or been revoked/)
      // A stale handle must not delete the replacement, either.
      await old.disconnect()
      const current = rig.accounts.sessionForSub('sub-1')!
      expect(current).not.toBe(old)
      expect(await rig.accounts.sessionFor(VAULT)).toBe(current)
      expect(await rig.accounts.sessionFor(WORK)).toBe(current)
      await expect(current.getAccessToken()).resolves.toBe('at-replacement')
      expect(rig.revoked).toEqual([])

      rig.setNow(NOW + 3_600_000)
      const first = current.getAccessToken()
      const second = (await rig.accounts.sessionFor(WORK))!.getAccessToken()
      await rig.refreshStarted.promise
      await expect(old.getAccessToken()).rejects.toThrow(/expired or been revoked/)
      expect(rig.refreshes).toHaveLength(1)
      rig.refreshReply.resolve(
        new Response(JSON.stringify({ access_token: 'at-refreshed', expires_in: 3600 })),
      )
      await expect(Promise.all([first, second])).resolves.toEqual(['at-refreshed', 'at-refreshed'])
    },
  )

  it('stops a retained multipage request before the next page after a same-token reconnect', async () => {
    const rig = await controlledConsent([auth()])
    const old = rig.accounts.sessionForSub('sub-1')!
    const atPage = deferred<void>()
    const pageReply = deferred<Response>()
    const request = vi.fn(async () => {
      atPage.resolve()
      return pageReply.promise
    })
    const api = new GoogleApi({ accessToken: () => old.getAccessToken(), fetch: request })
    const pages = api.getAll<string>(
      'https://www.googleapis.com/calendar/v3/calendars',
      {},
      (p) => p.items ?? [],
    )
    await atPage.promise
    const flow = await rig.accounts.connect(WORK)
    const outcome = flow.wait()
    await rig.exchanges[0]!.started.promise
    rig.exchanges[0]!.reply.resolve(auth({ accessToken: 'at-replacement' }))
    await outcome
    pageReply.resolve(new Response(JSON.stringify({ items: ['first'], nextPageToken: 'second' })))

    await expect(pages).rejects.toMatchObject({ code: 'reconnect' })
    expect(request).toHaveBeenCalledTimes(1)
    await expect(api.get('https://www.googleapis.com/calendar/v3/calendars')).rejects.toMatchObject(
      { code: 'reconnect' },
    )
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('keeps the receipt of a send already accepted before its session was replaced', async () => {
    const rig = await controlledConsent([auth()])
    const old = rig.accounts.sessionForSub('sub-1')!
    const atSend = deferred<void>()
    const receipt = deferred<Response>()
    const api = new GoogleApi({
      accessToken: () => old.getAccessToken(),
      fetch: async () => {
        atSend.resolve()
        return receipt.promise
      },
    })
    const sent = api.postJson('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      raw: 'message',
    })
    await atSend.promise
    const flow = await rig.accounts.connect(WORK)
    const outcome = flow.wait()
    await rig.exchanges[0]!.started.promise
    rig.exchanges[0]!.reply.resolve(auth({ accessToken: 'at-replacement' }))
    await outcome
    receipt.resolve(new Response(JSON.stringify({ id: 'accepted-send' })))

    await expect(sent).resolves.toEqual({ id: 'accepted-send' })
  })

  it.each(['stored', 'writing', 'queued'] as const)(
    'does not revoke a newer same-token consent while it is %s',
    async (stage) => {
      const rig = await controlledConsent()
      const first = await rig.accounts.connect(VAULT)
      const stale = first.wait()
      await rig.exchanges[0]!.started.promise
      const originalWrite = store.write.bind(store)
      const atWrite = deferred<void>()
      const releaseWrite = deferred<void>()
      let gated = false
      if (stage !== 'stored') {
        vi.spyOn(store, 'write').mockImplementation(async (value) => {
          if (!gated) {
            gated = true
            atWrite.resolve()
            await releaseWrite.promise
          }
          await originalWrite(value)
        })
      }
      // A separate account's write holds the queue so B owns a grant whose
      // persist callback has not even run when A's stale result arrives.
      let blocker: Promise<unknown> | undefined
      if (stage === 'queued') {
        const blocking = await rig.accounts.connect('another/vault')
        blocker = blocking.wait()
        await rig.exchanges[1]!.started.promise
        rig.exchanges[1]!.reply.resolve(auth({ sub: 'sub-other', refreshToken: 'rt-other' }))
        await atWrite.promise
      }
      const second = await rig.accounts.connect(WORK)
      const winner = second.wait()
      const exchange = rig.exchanges.at(-1)!
      await exchange.started.promise
      if (stage === 'queued') {
        // Queue stale revocation first; B then reserves the same token before
        // either queued operation can run. Drain microtasks, not a timed wait.
        rig.exchanges[0]!.reply.resolve(auth({ accessToken: 'at-stale' }))
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      exchange.reply.resolve(auth({ accessToken: 'at-winner' }))
      if (stage === 'stored') await winner
      else if (stage === 'writing') await atWrite.promise
      else await new Promise<void>((resolve) => setImmediate(resolve))
      if (stage !== 'queued') rig.exchanges[0]!.reply.resolve(auth({ accessToken: 'at-stale' }))
      releaseWrite.resolve()

      expect(await stale).toEqual({ kind: 'cancelled' })
      expect((await winner).kind).toBe('granted')
      await blocker
      expect(rig.revoked).not.toContain('rt-1')
      expect(await store.read()).toMatchObject({ 'sub-1': { accessToken: 'at-winner' } })
      await expect((await rig.accounts.sessionFor(WORK))!.getAccessToken()).resolves.toBe(
        'at-winner',
      )
      expect(await rig.accounts.sessionFor(VAULT)).toBeNull()
    },
  )

  it('still revokes a superseded consent when its refresh token differs from the winner', async () => {
    const rig = await controlledConsent()
    const first = await rig.accounts.connect(VAULT)
    const stale = first.wait()
    await rig.exchanges[0]!.started.promise
    const second = await rig.accounts.connect(WORK)
    const winner = second.wait()
    await rig.exchanges[1]!.started.promise
    rig.exchanges[1]!.reply.resolve(auth({ refreshToken: 'rt-winner', accessToken: 'at-winner' }))
    await winner
    rig.exchanges[0]!.reply.resolve(auth({ refreshToken: 'rt-stale' }))

    expect(await stale).toEqual({ kind: 'cancelled' })
    expect(rig.revoked).toEqual(['rt-stale'])
    await expect((await rig.accounts.sessionFor(WORK))!.getAccessToken()).resolves.toBe('at-winner')
  })

  it('does not let a stale expiry remove a same-token reconnect or its vault link', async () => {
    let state = ''
    let releaseRefresh!: () => void
    let refreshStarted!: () => void
    const atRefresh = new Promise<void>((resolve) => (refreshStarted = resolve))
    await store.write({ 'sub-1': auth({ expiresAt: NOW - 1 }) })
    const seeded = await createGoogleAccounts({
      store,
      vaults: createVaultAccounts(join(dir, 'google-vault-accounts.json')),
      clients: memoryClients(null),
      env: {},
      listen: async () => ({
        port: 45123,
        waitForRedirect: async () => ({ code: 'code', state }),
        close: () => {},
      }),
      openBrowser: async (url) => {
        state = new URL(url).searchParams.get('state') ?? ''
      },
      fetch: (async (_url: string, init: RequestInit) => {
        const params = new URLSearchParams(String(init.body))
        if (params.get('grant_type') === 'refresh_token') {
          refreshStarted()
          await new Promise<void>((resolve) => (releaseRefresh = resolve))
          return new Response('{"error":"invalid_grant"}', { status: 400 })
        }
        return new Response(
          JSON.stringify({
            access_token: 'at-reconnected',
            refresh_token: 'rt-1',
            expires_in: 3600,
            scope: 'openid',
            id_token: `header.${Buffer.from(JSON.stringify({ sub: 'sub-1', email: 'ada@syv.ai' })).toString('base64url')}.signature`,
          }),
          { status: 200 },
        )
      }) as unknown as typeof globalThis.fetch,
      now: () => NOW,
    })
    await seeded.link(VAULT, 'sub-1')
    const refresh = seeded.sessionForSub('sub-1')!.getAccessToken()
    await atRefresh
    const reconnect = await seeded.connect(WORK)
    await reconnect.wait()
    releaseRefresh()

    await expect(refresh).rejects.toThrow(/expired or been revoked/)
    expect(seeded.list()).toEqual([{ sub: 'sub-1', email: 'ada@syv.ai' }])
    expect(await store.read()).toMatchObject({
      'sub-1': { refreshToken: 'rt-1', accessToken: 'at-reconnected' },
    })
    expect(await seeded.sessionFor(VAULT)).not.toBeNull()
    expect(await seeded.sessionFor(WORK)).not.toBeNull()
  })

  it('keeps later account writes after an earlier queued store write fails', async () => {
    await store.write({
      'sub-1': auth({ expiresAt: NOW - 1 }),
      'sub-2': auth({
        sub: 'sub-2',
        email: 'work@syv.ai',
        refreshToken: 'rt-2',
        expiresAt: NOW - 1,
      }),
    })
    const realWrite = store.write.bind(store)
    let failOnce = true
    vi.spyOn(store, 'write').mockImplementation(async (value) => {
      if (failOnce) {
        failOnce = false
        throw new Error('synthetic disk failure')
      }
      await realWrite(value)
    })
    const accounts = await createGoogleAccounts({
      store,
      vaults: createVaultAccounts(join(dir, 'google-vault-accounts.json')),
      clients: memoryClients(null),
      env: {},
      listen: async () => ({
        port: 1,
        waitForRedirect: () => new Promise(() => {}),
        close: () => {},
      }),
      openBrowser: async () => {},
      fetch: (async () =>
        new Response(JSON.stringify({ access_token: 'at-refreshed', expires_in: 3600 }), {
          status: 200,
        })) as unknown as typeof globalThis.fetch,
      now: () => NOW,
    })
    const first = accounts.sessionForSub('sub-1')!.getAccessToken()
    const second = accounts.sessionForSub('sub-2')!.getAccessToken()

    await expect(first).rejects.toThrow('synthetic disk failure')
    await expect(second).resolves.toBe('at-refreshed')
    expect(await store.read()).toMatchObject({ 'sub-2': { accessToken: 'at-refreshed' } })
  })

  it('preserves independent refreshes while links and unlinks run concurrently', async () => {
    let startedOne!: () => void
    let startedTwo!: () => void
    const atOne = new Promise<void>((resolve) => (startedOne = resolve))
    const atTwo = new Promise<void>((resolve) => (startedTwo = resolve))
    let releaseOne!: () => void
    let releaseTwo!: () => void
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const token = new URLSearchParams(String(init.body)).get('refresh_token')
      if (token === 'rt-1') {
        startedOne()
        await new Promise<void>((resolve) => (releaseOne = resolve))
      } else {
        startedTwo()
        await new Promise<void>((resolve) => (releaseTwo = resolve))
      }
      return new Response(JSON.stringify({ access_token: `at-${token}`, expires_in: 3600 }), {
        status: 200,
      })
    }) as unknown as typeof globalThis.fetch
    const accounts = await manager(
      [
        auth({ expiresAt: NOW - 1 }),
        auth({ sub: 'sub-2', email: 'work@syv.ai', refreshToken: 'rt-2', expiresAt: NOW - 1 }),
      ],
      fetchImpl,
    )
    await accounts.link(VAULT, 'sub-1')
    await accounts.link(WORK, 'sub-2')
    const one = accounts.sessionForSub('sub-1')!.getAccessToken()
    const two = accounts.sessionForSub('sub-2')!.getAccessToken()
    await Promise.all([atOne, atTwo])
    const remapping = accounts.link(VAULT, 'sub-2')
    const unlinking = accounts.unlinkVault(WORK)
    releaseOne()
    releaseTwo()

    await Promise.all([one, two, remapping, unlinking])
    expect(await store.read()).toMatchObject({
      'sub-1': { accessToken: 'at-rt-1' },
      'sub-2': { accessToken: 'at-rt-2' },
    })
    expect(await accounts.sessionFor(VAULT)).toBe(accounts.sessionForSub('sub-2'))
    expect(await accounts.sessionFor(WORK)).toBeNull()
  })

  it('does not bring back an account removed while it was refreshing', async () => {
    let release = () => {}
    let refreshing = () => {}
    const atGoogle = new Promise<void>((resolve) => (refreshing = resolve))
    const fetchImpl = (async (url: string) => {
      if (url === REVOKE) return new Response('{}', { status: 200 })
      refreshing()
      await new Promise<void>((resolve) => (release = resolve))
      return new Response(JSON.stringify({ access_token: 'at-2', expires_in: 3600 }), {
        status: 200,
      })
    }) as unknown as typeof globalThis.fetch
    const accounts = await manager([auth({ expiresAt: NOW - 1 })], fetchImpl)
    await accounts.link(VAULT, 'sub-1')

    const token = accounts.sessionForSub('sub-1')!.getAccessToken()
    await atGoogle
    await accounts.removeAccount('sub-1')
    release()
    await expect(token).rejects.toThrow(/expired or been revoked/)

    expect(accounts.list()).toEqual([])
    expect(await store.read()).toEqual({})
    expect(await accounts.sessionFor(VAULT)).toBeNull()
  })
})

describe('resolveClient', () => {
  const OWN = { id: 'own.apps.googleusercontent.com', secret: 'own-secret' }
  const ENV = { HOLI_GOOGLE_CLIENT_ID: 'env.apps.googleusercontent.com' }

  it('prefers this machine’s own client over the environment', () => {
    expect(resolveClient(OWN, ENV)).toEqual({ ...OWN, source: 'own' })
  })

  it('prefers the environment over the shipped client, secret and all', () => {
    // Never the env id with the shipped secret: Google refuses a mixed pair.
    expect(resolveClient(null, ENV)).toEqual({
      id: ENV.HOLI_GOOGLE_CLIENT_ID,
      source: 'environment',
    })
    expect(resolveClient(null, { ...ENV, HOLI_GOOGLE_CLIENT_SECRET: 'env-secret' })).toEqual({
      id: ENV.HOLI_GOOGLE_CLIENT_ID,
      secret: 'env-secret',
      source: 'environment',
    })
  })

  it('falls back to the shipped client', () => {
    expect(resolveClient(null, {})).toEqual({
      id: GOOGLE_CLIENT_ID,
      secret: GOOGLE_CLIENT_SECRET,
      source: 'shipped',
    })
  })
})
