import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { emptyVaultSnapshot } from '@holi/shared'
import { createCapabilityRegistry } from '../../../main/capabilities/registry'
import { noCoreServices } from '../../../main/capabilities/services'
import { createGoogleAccounts } from '../main/accounts'
import { GOOGLE_NAMESPACES, googleCapabilities } from '../main/capabilities'
import { createClientStore, type GoogleClient } from '../main/credentials'
import { createVaultAccounts } from '../main/vault-accounts'
import { GoogleTokenStore } from '../main/token-store'

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
  decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ''),
}
const client: GoogleClient = { id: 'test.apps.googleusercontent.com', secret: 'opaque-secret' }
const dirs: string[] = []
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))),
)

async function rig(options: { delayClientRead?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'google-consent-isolation-'))
  dirs.push(dir)
  const tokenStore = new GoogleTokenStore(join(dir, 'tokens.enc'), safeStorage)
  const vaults = createVaultAccounts(join(dir, 'vaults.json'))
  const storedClients = createClientStore(join(dir, 'clients.enc'), safeStorage)
  await storedClients.write(client)
  let releaseClient!: (value: GoogleClient | null) => void
  let clientReadStarted!: () => void
  const readStarted = new Promise<void>((resolve) => (clientReadStarted = resolve))
  const clients = options.delayClientRead
    ? {
        ...storedClients,
        readVault: async () => {
          clientReadStarted()
          return new Promise<GoogleClient | null>((resolve) => (releaseClient = resolve))
        },
      }
    : storedClients
  let redirect!: (value: { code: string; state: string }) => void
  let authUrl: URL | null = null
  const opened: string[] = []
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body))
    if (form.get('grant_type') === 'authorization_code') {
      return Response.json({
        access_token: 'secret-access',
        refresh_token: 'secret-refresh',
        expires_in: 3600,
        scope:
          'openid email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar',
        id_token: `header.${Buffer.from(JSON.stringify({ sub: 'synthetic-sub', email: 'a@example.test' })).toString('base64url')}.signature`,
      })
    }
    return Response.json({})
  })
  const accounts = await createGoogleAccounts({
    store: tokenStore,
    vaults,
    clients,
    env: {},
    fetch: fetch as typeof globalThis.fetch,
    listen: async () => ({
      port: 43129,
      waitForRedirect: () =>
        new Promise((resolve) => {
          redirect = resolve
        }),
      close: () => {},
    }),
    openBrowser: async (url) => {
      opened.push(url)
      authUrl = new URL(url)
    },
  })
  const registry = createCapabilityRegistry()
  registry.register(
    GOOGLE_NAMESPACES,
    googleCapabilities({
      accounts,
      dataFor: async () => null,
      settings: {
        read: async () => ({ calendars: {}, imageSenders: [], imagesFromAllSenders: false }),
        write: async () => {},
      },
    }),
  )
  const run = (remote: string, name: string) =>
    registry.run(
      `google.${name}`,
      'ui',
      {
        remote,
        root: '',
        bundle: null,
        snapshot: async () => emptyVaultSnapshot(),
        claims: async () => [],
        core: noCoreServices(),
      },
      {},
    )
  return {
    accounts,
    run,
    opened,
    fetch,
    readStarted,
    releaseClient: (value: GoogleClient | null) => releaseClient(value),
    redirect: (value: { code: string; state: string }) => redirect(value),
    auth: () => authUrl,
  }
}

it('keeps consent and its completion scoped to the initiating vault', async () => {
  const r = await rig()
  const started = await r.run('owner/a', 'connect')
  const secretBearing = JSON.stringify(started)
  expect(secretBearing).not.toContain(client.secret)
  await expect(r.run('owner/b', 'awaitConnect')).rejects.toThrow()
  await r.run('owner/b', 'cancelConnect')
  const url = r.auth()!
  r.redirect({ code: 'synthetic-code', state: url.searchParams.get('state')! })
  const result = await r.run('owner/a', 'awaitConnect')
  expect(result.value).toMatchObject({ kind: 'granted', account: { email: 'a@example.test' } })
  expect(JSON.stringify(result)).not.toMatch(/secret-access|secret-refresh|opaque-secret/)
  expect((await r.run('owner/a', 'status')).value).toMatchObject({
    account: { email: 'a@example.test' },
  })
  expect((await r.run('owner/b', 'status')).value).toMatchObject({ account: null })
  expect((await r.run('owner/b', 'allAccounts')).value).toMatchObject({
    accounts: [],
    current: null,
  })
  expect(r.opened).toHaveLength(1)
})

it('cancels a connect while its vault client is still being read', async () => {
  const r = await rig({ delayClientRead: true })
  const pending = r.run('owner/a', 'connect')
  await r.readStarted
  await r.run('owner/a', 'cancelConnect')
  r.releaseClient(null)
  await expect(pending).rejects.toThrow(/cancel/i)
  expect(r.opened).toEqual([])
  expect((await r.run('owner/a', 'status')).value).toMatchObject({ account: null })
  expect((await r.run('owner/a', 'allAccounts')).value).toMatchObject({
    accounts: [],
    current: null,
  })
})
