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
import { createGoogleAccounts } from '../main/accounts'
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  resolveClient,
  type GoogleClient,
  type GoogleClientStore,
} from '../main/credentials'
import { createVaultAccounts } from '../main/vault-accounts'
import { GoogleTokenStore, type StoredGoogleAuth } from '../main/token-store'
import type { LoopbackServer } from '../main/loopback-flow'

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
    await token

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
