/**
 * `createGoogleAccounts` — the owner of the token store, and the one place that
 * turns a vault into a session (D87).
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
import { createGoogleAccounts } from '../src/main/google/accounts'
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } from '../src/main/google/credentials'
import { createVaultAccounts } from '../src/main/google/vault-accounts'
import { GoogleTokenStore, type StoredGoogleAuth } from '../src/main/google/token-store'
import type { LoopbackServer } from '../src/main/google/loopback-flow'

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
    clientId: 'client-1',
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
    const accounts = await manager([auth()], (async () =>
      new Response('{}', { status: 200 })) as unknown as typeof globalThis.fetch)
    accounts.onChange((sub) => seen.push(sub))

    await accounts.link(VAULT, 'sub-1')
    await accounts.removeAccount('sub-1')

    expect(seen).toContain('sub-1')
  })
})

describe('the client credentials', () => {
  /**
   * `electron.ts` builds the manager with **no** `clientId` and no
   * `clientSecret` — it always relied on the resolver that `GoogleSession`
   * carried, and D87 moved `connect` here without bringing it along. Every rig
   * above passes `clientId: 'client-1'`, which is exactly why the empty-string
   * fallback shipped: consent died at Google with `Missing required parameter:
   * client_id` before the user ever saw a consent screen.
   *
   * So this builds the manager the way production does, and asserts both halves.
   * The secret is the half that fails later and reads differently — at the token
   * exchange, after consent has already been given.
   */
  async function productionManager(exchange: { calls: Array<Record<string, string>> }) {
    let state = ''
    return createGoogleAccounts({
      store,
      vaults: createVaultAccounts(join(dir, 'google-vault-accounts.json')),
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
        exchange.calls.push(
          Object.fromEntries(new URLSearchParams(String(init.body)).entries()),
        )
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
})
