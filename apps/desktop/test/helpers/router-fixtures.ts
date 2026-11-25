import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, vi } from 'vitest'
import { taskClaim } from '@holi/shared'
import { createVaultHost, type VaultHost } from '../../src/main/vault/active-vault'
import { seedVault } from './seed'
import { createCapabilityHost } from '../../src/main/capabilities/dispatch'
import { createCapabilityRegistry } from '../../src/main/capabilities/registry'
import { noCoreServices } from '../../src/main/capabilities/services'
import { vaultCapabilities, VAULT_NAMESPACES } from '../../src/main/capabilities/vault-caps'
import { taskCapabilities, TASKS_NAMESPACES } from '../../src/plugins/tasks/main/capabilities'
import { createRouter, type RouterDeps } from '../../src/main/router'
import { GitHubSession } from '../../src/main/github/session'
import {
  TokenStore,
  type SafeStorageLike,
  type StoredAuth,
} from '../../src/main/github/token-store'
import { VaultRegistry } from '../../src/main/vault/registry'

export const REMOTE = 'syv-ai/1brain'
export const TODAY = '2026-07-21'
/** Tasks, still a core claim: what the scanner claims in these vaults. */
export const TASKS = async () => [{ ...taskClaim, plugin: 'tasks' }]

export const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

export const storage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${Buffer.from(plain, 'utf8').toString('base64')}`),
  decryptString: (buf) => Buffer.from(buf.toString('utf8').slice(4), 'base64').toString('utf8'),
}

/**
 * A session over a real store. Signed out unless `auth` is given — most suites
 * do not care, and the ones that do stub `session.api` directly rather than
 * scripting a network.
 */
async function idleSession(base: string, auth?: StoredAuth): Promise<GitHubSession> {
  const store = new TokenStore(join(base, 'github-auth.enc'), storage)
  if (auth) await store.write(auth)
  return GitHubSession.load({
    store,
    fetch: (() => {
      throw new Error('no network in this rig')
    }) as unknown as typeof globalThis.fetch,
  })
}

/**
 * Hosts the running test built, closed after EACH test. Closing one with a vault
 * open commits, pushes and stops a watcher, about half a second; leaving them
 * all to one `afterAll` closed nineteen live vaults in a row and ran that hook
 * past its 10 s limit, with every one of them watching and ticking until then.
 */
export const hosts: VaultHost[] = []

afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close().catch(() => {})
})

export async function rig(
  files: Record<string, string> = {},
  auth?: StoredAuth,
  overridesOrPrepare:
    | (Pick<RouterDeps, 'seed' | 'opened'> & {
        reconcile?: RouterDeps['plugins']['reconcile']
        setDisplayed?: RouterDeps['plugins']['setDisplayed']
        prepareClone?: RouterDeps['prepareClone']
      })
    | (() => Promise<void>) = {},
  onSeed: typeof seedVault = seedVault,
) {
  const overrides =
    typeof overridesOrPrepare === 'function'
      ? { prepareClone: overridesOrPrepare, seed: onSeed }
      : overridesOrPrepare
  const base = await mkdtemp(join(tmpdir(), 'holi-rt-'))
  dirs.push(base)
  const root = join(base, 'clone')
  for (const [rel, text] of Object.entries(files)) {
    await writeFile(join(root, rel), text, 'utf8').catch(async () => {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(root, rel, '..'), { recursive: true })
      await writeFile(join(root, rel), text, 'utf8')
    })
  }
  // A real vault carries its seeded files, written at creation. Building the rig
  // without them made every snapshot assertion here describe a vault that
  // cannot exist.
  await mkdir(root, { recursive: true })
  await seedVault(root)
  const registry = new VaultRegistry(join(base, 'vaults.json'))
  await registry.add({
    remote: REMOTE,
    path: root,
    name: '1brain',
    lastOpenedAt: '2026-07-01T00:00:00Z',
  })
  const session = await idleSession(base, auth)
  // Timers are effectively off: these tests drive the vault explicitly, and a
  // background loop firing mid-assertion is noise, not coverage. The loop's own
  // behaviour is tested in active-vault.test.ts.
  const host = createVaultHost({
    registry,
    // Status observations must not contend with the fixture's explicit writes.
    gitDeps: { env: { GIT_OPTIONAL_LOCKS: '0' } },
    claims: TASKS,
    onSnapshot: () => {},
    onSyncState: () => {},
    timings: { pullIntervalMs: 3_600_000, healIntervalMs: 3_600_000, commitQuietMs: 3_600_000 },
  })
  hosts.push(host)
  const trashItem = vi.fn(async () => {})
  const showItemInFolder = vi.fn()
  // Core's capabilities and the tasks', for `cap.run`.
  const capabilities = createCapabilityRegistry()
  capabilities.register(
    VAULT_NAMESPACES,
    vaultCapabilities({
      updateSkills: async () => ({ summary: '', conflicts: null }),
      pendingSkills: async () => [],
      open: () => {},
      screenshot: async () => new Uint8Array(),
    }),
  )
  capabilities.register(TASKS_NAMESPACES, taskCapabilities({ today: () => TODAY }))
  const capabilityHost = createCapabilityHost({
    registry: capabilities,
    rootFor: async (remote) =>
      (await registry.list()).find((e) => e.remote === remote)?.path ?? null,
    get: (remote) => {
      const active = host.active()
      return active?.remote === remote ? active : null
    },
    core: noCoreServices,
    pluginEnabled: async () => true,
    claims: TASKS,
  })
  const openPastedHoliLink = vi.fn(async (url: string) =>
    url.includes('valid')
      ? { ok: true as const }
      : { ok: false as const, message: 'failure', detail: 'detail' },
  )
  const caller = createRouter({
    openPastedHoliLink,
    seed: overrides.seed ?? seedVault,
    plugins: {
      reconcile: overrides.reconcile ?? (async () => {}),
      invalidate: () => {},
      setDisplayed: overrides.setDisplayed ?? (() => {}),
      syncBackground: async () => {},
      failures: () => ({}),
      scanClaimsFor: TASKS,
    },
    capabilities: capabilityHost,
    registry,
    session,
    host,
    userData: join(base, 'user-data'),
    vaultRoot: join(base, 'Holi'),
    prepareClone: overrides.prepareClone ?? (async () => {}),
    openExternal: async () => {},
    trashItem,
    showItemInFolder,
    now: () => '2026-07-21T12:00:00Z',
    today: () => TODAY,
    opened: overrides.opened,
  }).createCaller({})
  return {
    caller,
    root,
    registry,
    host,
    session,
    base,
    userData: join(base, 'user-data'),
    trashItem,
    showItemInFolder,
    capabilities,
    openPastedHoliLink,
  }
}
