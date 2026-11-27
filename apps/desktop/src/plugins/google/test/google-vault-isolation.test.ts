import { mkdtemp, rm } from 'node:fs/promises'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGoogleAccounts } from '../main/accounts'
import { googleConnectionId } from '../main/connection-id'
import { createClientStore, type GoogleClient } from '../main/credentials'
import { createVaultAccounts } from '../main/vault-accounts'
import { GoogleTokenStore, type StoredGoogleAuth } from '../main/token-store'

const encryptionKey = randomBytes(32)
const syntheticSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
  },
  decryptString: (encrypted: Buffer) => {
    const iv = encrypted.subarray(0, 12)
    const tag = encrypted.subarray(12, 28)
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString(
      'utf8',
    )
  },
}
const grant: StoredGoogleAuth = {
  sub: 'google-subject',
  email: 'person@example.com',
  refreshToken: 'refresh-token',
  accessToken: 'access-token',
  expiresAt: Date.now() + 3_600_000,
  scopes: ['openid', 'email'],
}
const ownClient = (id: string): GoogleClient => ({
  id: `${id}.apps.googleusercontent.com`,
  secret: 'client-secret-value',
})

let dir: string
let tokenStore: GoogleTokenStore
let vaults: ReturnType<typeof createVaultAccounts>
let clients: ReturnType<typeof createClientStore>
const network = vi.fn(async (_url: unknown, init?: RequestInit) => {
  const params = new URLSearchParams(String(init?.body))
  if (params.get('grant_type') === 'authorization_code')
    return new Response(
      JSON.stringify({
        access_token: grant.accessToken,
        refresh_token: grant.refreshToken,
        expires_in: 3600,
        scope: grant.scopes.join(' '),
        id_token: `header.${Buffer.from(JSON.stringify({ sub: grant.sub, email: grant.email })).toString('base64url')}.signature`,
      }),
    )
  return new Response('{}')
})

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'google-vault-isolation-'))
  tokenStore = new GoogleTokenStore(join(dir, 'tokens.enc'), syntheticSafeStorage)
  vaults = createVaultAccounts(join(dir, 'vaults.json'))
  clients = createClientStore(join(dir, 'clients.enc'), syntheticSafeStorage)
  network.mockClear()
})
afterEach(async () => rm(dir, { recursive: true, force: true }))

async function manager(
  overrides: Pick<Parameters<typeof createGoogleAccounts>[0], 'fetch' | 'now'> = {},
) {
  let redirect!: (value: { code: string; state: string }) => void
  const redirected = new Promise<{ code: string; state: string }>((resolve) => {
    redirect = resolve
  })
  return createGoogleAccounts({
    store: tokenStore,
    vaults,
    clients,
    env: {},
    fetch: network as unknown as typeof fetch,
    listen: async () => ({
      port: 1,
      waitForRedirect: () => redirected,
      close: () => {},
    }),
    openBrowser: async (url) => {
      redirect({ code: 'synthetic-code', state: new URL(url).searchParams.get('state')! })
    },
    ...overrides,
  })
}

describe('Google vault isolation', () => {
  it('scopes the same Google subject to distinct opaque vault connections and refuses foreign operations before network access', async () => {
    await clients.write(ownClient('machine'))
    const clientA = ownClient('issuer-a')
    const clientB = ownClient('issuer-b')
    await tokenStore.write({
      one: { ...grant, client: { ...clientA, source: 'own' } },
      two: { ...grant, client: { ...clientB, source: 'own' } },
    })
    await vaults.link('owner/one', googleConnectionId('owner/one', clientA.id, grant.sub))
    await vaults.link('owner/two', googleConnectionId('owner/two', clientB.id, grant.sub))
    const accounts = await manager()
    const first = await accounts.sessionFor('owner/one')
    const second = await accounts.sessionFor('owner/two')
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(first).not.toBe(second)
    expect(first!.accountSub).not.toBe(second!.accountSub)
    expect(first!.accountSub).not.toBe(grant.sub)
    await expect(accounts.link('owner/one', second!.accountSub!)).rejects.toThrow()
    await expect(accounts.removeAccount('owner/one', second!.accountSub!)).rejects.toThrow()
    expect(accounts.list('owner/new')).toEqual([])
    expect(accounts.list('owner/one')).toHaveLength(1)
    expect(network).not.toHaveBeenCalled()
  })

  it('migrates only explicit legacy links and never assigns an unlinked stored grant', async () => {
    await clients.write(ownClient('machine'))
    await tokenStore.write({ subject: grant })
    // A legacy link is the pre-manager state: startup must migrate this one,
    // without interpreting every stored grant as belonging to a vault.
    await vaults.link('owner/legacy', grant.sub)
    const accounts = await manager()
    expect(await accounts.sessionFor('owner/legacy')).not.toBeNull()
    expect(await accounts.sessionFor('owner/unlinked')).toBeNull()
  })

  it('keeps explicitly linked owners fenced while sharing one physical refresh, and unlinking one does not revoke the grant', async () => {
    const expired = { ...grant, expiresAt: 0 }
    await tokenStore.write({ subject: expired })
    await vaults.link('owner/one', grant.sub)
    await vaults.link('owner/two', grant.sub)
    let release!: (response: Response) => void
    const refresh = new Promise<Response>((resolve) => {
      release = resolve
    })
    const fetch = vi.fn(async () => refresh)
    const accounts = await createGoogleAccounts({
      store: tokenStore,
      vaults,
      clients,
      env: {},
      fetch: fetch as unknown as typeof globalThis.fetch,
      listen: async () => ({
        port: 1,
        waitForRedirect: async () => ({ code: '', state: '' }),
        close: () => {},
      }),
      openBrowser: async () => {},
    })
    const left = await accounts.sessionFor('owner/one')
    const right = await accounts.sessionFor('owner/two')
    expect(left).not.toBe(right)
    const a = left!.getAccessToken()
    const b = right!.getAccessToken()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await accounts.unlinkVault('owner/one')
    expect(await accounts.sessionFor('owner/two')).not.toBeNull()
    const refused = expect(a).rejects.toThrow()
    release(
      new Response(JSON.stringify({ access_token: 'new-access', expires_in: 3600 }), {
        status: 200,
      }),
    )
    await refused
    await expect(b).resolves.toBe('new-access')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps the newest vault client when an earlier read finishes late', async () => {
    await clients.writeVault('owner/one', ownClient('old'))
    let releaseOld!: (client: GoogleClient | null) => void
    let reads = 0
    const delayed = {
      ...clients,
      readVault: async (remote: string) => {
        if (remote !== 'owner/one') return clients.readVault(remote)
        reads += 1
        if (reads === 1)
          return new Promise<GoogleClient | null>((resolve) => (releaseOld = resolve))
        return clients.readVault(remote)
      },
    }
    const accounts = await createGoogleAccounts({
      store: tokenStore,
      vaults,
      clients: delayed,
      listen: async () => ({
        port: 1,
        waitForRedirect: async () => ({ code: '', state: '' }),
        close: () => {},
      }),
      openBrowser: async () => {},
    })
    const oldRead = accounts.client('owner/one')
    await vi.waitFor(() => expect(reads).toBe(1))
    await accounts.setClient('owner/one', ownClient('new'))
    releaseOld(ownClient('old'))
    await oldRead
    expect(await accounts.client('owner/one')).toMatchObject({
      id: ownClient('new').id,
      source: 'own',
    })
    expect(await delayed.readVault('owner/one')).toEqual(ownClient('new'))
  })

  it('does not let a stalled older connect replace or cancel a newer vault flow', async () => {
    let releaseRead!: (client: GoogleClient | null) => void
    let reads = 0
    const delayed = {
      ...clients,
      readVault: async (remote: string) => {
        if (remote === 'owner/a' && ++reads === 1)
          return new Promise<GoogleClient | null>((resolve) => (releaseRead = resolve))
        return clients.readVault(remote)
      },
    }
    let redirect!: (value: { code: string; state: string }) => void
    let redirectPromise: Promise<{ code: string; state: string }> | null = null
    const accounts = await createGoogleAccounts({
      store: tokenStore,
      vaults,
      clients: delayed,
      fetch: network as unknown as typeof fetch,
      listen: async () => {
        redirectPromise = new Promise((resolve) => (redirect = resolve))
        return { port: 1, waitForRedirect: () => redirectPromise!, close: () => {} }
      },
      openBrowser: async (url) =>
        redirect({ code: 'synthetic-code', state: new URL(url).searchParams.get('state')! }),
    })
    const older = accounts.connect('owner/a')
    const rejected = expect(older).rejects.toThrow(/cancel/i)
    await vi.waitFor(() => expect(reads).toBe(1))
    const newer = await accounts.connect('owner/b')
    let newerSettled = false
    const newerResult = newer.wait().finally(() => {
      newerSettled = true
    })
    accounts.cancelConnect('owner/a')
    await Promise.resolve()
    expect(newerSettled).toBe(false)
    releaseRead(null)
    await rejected
    accounts.cancelConnect('owner/b')
    await expect(newerResult).resolves.toMatchObject({ kind: 'cancelled' })
  })

  it('does not reactivate an old wrapper after unlink and relink, and persists a vault client reset', async () => {
    await clients.write(ownClient('machine'))
    await tokenStore.write({ subject: grant })
    await vaults.link('owner/one', grant.sub)
    const accounts = await manager()
    const old = await accounts.sessionFor('owner/one')
    await accounts.unlinkVault('owner/one')
    await (await accounts.connect('owner/one')).wait()
    const current = await accounts.sessionFor('owner/one')
    expect(old!.account).toBeNull()
    await expect(old!.getAccessToken()).rejects.toThrow()
    expect(current).not.toBe(old)
    await accounts.setClient('owner/one', ownClient('vault'))
    await accounts.setClient('owner/one', null)
    const restarted = await manager()
    expect(await restarted.client('owner/one')).toEqual(await accounts.client('owner/one'))
    expect(await restarted.client('owner/new')).toEqual(await accounts.client('owner/new'))
  })
})

describe('vault issuing credentials', () => {
  it('repairs only the owner issuer, persists it across future-client changes, and keeps one refresh and last-owner revoke', async () => {
    const original = ownClient('shared-issuer')
    const repaired = { ...original, secret: 'repaired-owner-secret' }
    await clients.writeVault('owner/a', original)
    await clients.writeVault('owner/b', original)
    await tokenStore.write({
      legacy: { ...grant, expiresAt: 0, client: { ...original, source: 'own' } },
    })
    await vaults.link('owner/a', grant.sub)
    await vaults.link('owner/b', grant.sub)
    let now = 100_000
    const refreshes: URLSearchParams[] = []
    const revoked: string[] = []
    const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const fields = new URLSearchParams(String(init?.body))
      if (String(url).endsWith('/revoke')) {
        revoked.push(fields.get('token')!)
        return Response.json({})
      }
      expect(fields.get('grant_type')).toBe('refresh_token')
      refreshes.push(fields)
      return Response.json({
        access_token: `access-${refreshes.length}`,
        refresh_token: `rotated-${refreshes.length}`,
        expires_in: 3600,
      })
    })
    const accounts = await manager({ now: () => now, fetch: transport })
    await accounts.setClient('owner/a', repaired)
    const a = (await accounts.sessionFor('owner/a'))!
    const b = (await accounts.sessionFor('owner/b'))!
    await expect(Promise.all([a.getAccessToken(), b.getAccessToken()])).resolves.toEqual([
      'access-1',
      'access-1',
    ])
    expect(refreshes).toHaveLength(1)
    await accounts.setClient('owner/a', ownClient('future-only'))

    tokenStore = new GoogleTokenStore(join(dir, 'tokens.enc'), syntheticSafeStorage)
    clients = createClientStore(join(dir, 'clients.enc'), syntheticSafeStorage)
    vaults = createVaultAccounts(join(dir, 'vaults.json'))
    const restarted = await manager({ now: () => now, fetch: transport })
    expect((await restarted.client('owner/a')).id).toBe(ownClient('future-only').id)
    expect((await restarted.overview('owner/a')).client.id).toBe(original.id)
    now += 3_600_001
    await expect((await restarted.sessionFor('owner/a'))!.getAccessToken()).resolves.toBe(
      'access-2',
    )
    now += 3_600_001
    await expect((await restarted.sessionFor('owner/b'))!.getAccessToken()).resolves.toBe(
      'access-3',
    )
    expect(
      refreshes.map((fields) => [
        fields.get('client_id'),
        fields.get('client_secret'),
        fields.get('refresh_token'),
      ]),
    ).toEqual([
      [original.id, repaired.secret, grant.refreshToken],
      [original.id, repaired.secret, 'rotated-1'],
      [original.id, original.secret, 'rotated-2'],
    ])
    await restarted.removeAccount('owner/a', restarted.list('owner/a')[0]!.sub)
    expect(revoked).toEqual([])
    await expect((await restarted.sessionFor('owner/b'))!.getAccessToken()).resolves.toBe(
      'access-3',
    )
    await restarted.removeAccount('owner/b', restarted.list('owner/b')[0]!.sub)
    expect(revoked).toEqual(['rotated-3'])
  })

  it('keeps every other owner issuer when same-client native consent replaces the base issuer', async () => {
    const original = ownClient('shared-issuer')
    const repaired = { ...original, secret: 'owner-a-repaired' }
    const consent = { ...original, secret: 'owner-b-consent' }
    for (const remote of ['owner/a', 'owner/b', 'owner/c']) {
      await clients.writeVault(remote, remote === 'owner/b' ? consent : original)
      await vaults.link(remote, grant.sub)
    }
    await tokenStore.write({ legacy: { ...grant, client: { ...original, source: 'environment' } } })
    let now = 100_000
    const refreshes: URLSearchParams[] = []
    const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const fields = new URLSearchParams(String(init?.body))
      if (fields.get('grant_type') === 'authorization_code') {
        expect(fields.get('client_secret')).toBe(consent.secret)
        return network(url, init)
      }
      expect(fields.get('grant_type')).toBe('refresh_token')
      refreshes.push(fields)
      return Response.json({ access_token: `access-${refreshes.length}`, expires_in: 3600 })
    })
    const accounts = await manager({ now: () => now, fetch: transport })
    await accounts.setClient('owner/a', repaired)
    expect((await (await accounts.connect('owner/b')).wait()).kind).toBe('granted')
    tokenStore = new GoogleTokenStore(join(dir, 'tokens.enc'), syntheticSafeStorage)
    clients = createClientStore(join(dir, 'clients.enc'), syntheticSafeStorage)
    vaults = createVaultAccounts(join(dir, 'vaults.json'))
    const restarted = await manager({ now: () => now, fetch: transport })
    for (const remote of ['owner/a', 'owner/b', 'owner/c']) {
      now += 3_600_001
      await (await restarted.sessionFor(remote))!.getAccessToken()
    }
    expect(refreshes.map((fields) => fields.get('client_secret'))).toEqual([
      repaired.secret,
      consent.secret,
      original.secret,
    ])
    expect((await restarted.overview('owner/c')).client).toEqual({
      id: original.id,
      source: 'environment',
    })
    expect((await restarted.overview('owner/a')).client).toEqual({ id: original.id, source: 'own' })
  })

  it('preserves a committed issuer repair when an earlier refresh rotates the token after it', async () => {
    const original = ownClient('shared-issuer')
    const repaired = { ...original, secret: 'new-owner-secret' }
    await clients.writeVault('owner/a', original)
    await vaults.link('owner/a', grant.sub)
    await tokenStore.write({
      legacy: { ...grant, expiresAt: 0, client: { ...original, source: 'own' } },
    })
    let now = 100_000
    let started!: () => void
    let release!: (response: Response) => void
    const atNetwork = new Promise<void>((resolve) => {
      started = resolve
    })
    const response = new Promise<Response>((resolve) => {
      release = resolve
    })
    const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const fields = new URLSearchParams(String(init?.body))
      if (fields.get('refresh_token') === grant.refreshToken) {
        started()
        return response
      }
      expect(fields.get('refresh_token')).toBe('rotated-during-repair')
      expect(fields.get('client_id')).toBe(original.id)
      expect(fields.get('client_secret')).toBe(repaired.secret)
      return Response.json({ access_token: 'after-restart', expires_in: 3600 })
    })
    const accounts = await manager({ now: () => now, fetch: transport })
    const pending = (await accounts.sessionFor('owner/a'))!.getAccessToken()
    await atNetwork
    try {
      await accounts.setClient('owner/a', repaired)
    } finally {
      release(
        Response.json({
          access_token: 'before-restart',
          refresh_token: 'rotated-during-repair',
          expires_in: 3600,
        }),
      )
      await pending
    }
    tokenStore = new GoogleTokenStore(join(dir, 'tokens.enc'), syntheticSafeStorage)
    clients = createClientStore(join(dir, 'clients.enc'), syntheticSafeStorage)
    vaults = createVaultAccounts(join(dir, 'vaults.json'))
    now += 3_600_001
    const restarted = await manager({ now: () => now, fetch: transport })
    await expect((await restarted.sessionFor('owner/a'))!.getAccessToken()).resolves.toBe(
      'after-restart',
    )
  })
})
