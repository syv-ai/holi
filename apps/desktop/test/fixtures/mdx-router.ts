import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { afterEach, vi } from 'vitest'
import { createRouter } from '../../src/main/router'
import { GitHubSession } from '../../src/main/github/session'
import {
  TokenStore,
  type SafeStorageLike,
  type StoredAuth,
} from '../../src/main/github/token-store'
import { createMdxTrustStore, type MdxTrustStore } from '../../src/main/mdx-trust'
import {
  createMdxConsentStore,
  withMdxConsentQuit,
  type MdxConsentStore,
} from '../../src/main/mdx-consent'
import { trackMdxDocument } from '../../src/main/mdx-document-lifetime'
import { MdxExternalDataError, type fetchMdxExternalData } from '../../src/main/mdx-external-data'
import type { MdxResources } from '../../src/main/mdx-resources'
import { VaultRegistry } from '../../src/main/vault/registry'
import type { ActiveVault, VaultHost } from '../../src/main/vault/active-vault'

const storage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${Buffer.from(plain).toString('base64')}`),
  decryptString: (buf) => Buffer.from(buf.toString().slice(4), 'base64').toString(),
}

export const auth = (accountId: number, login: string): StoredAuth => ({
  token: `token-${accountId}`,
  accountId,
  login,
  scopes: ['repo'],
})

export const REMOTE = 'syv-ai/notes'

export const gate = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

async function fixture(
  options: {
    signedIn?: StoredAuth
    fetch?: typeof fetch
    trust?: (store: MdxTrustStore) => MdxTrustStore
    consent?: (store: MdxConsentStore) => MdxConsentStore
    inspect?: MdxResources['inspect']
    externalFetch?: typeof fetchMdxExternalData
    document?: WebContents
    onResourceChange?: () => void
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'holi-mdx-router-'))
  const root = join(dir, 'vault')
  await mkdir(root, { recursive: true })
  const registry = new VaultRegistry(join(dir, 'vaults.json'))
  await registry.add({ remote: REMOTE, path: root, name: 'notes', lastOpenedAt: '2026-01-01' })
  const tokenStore = new TokenStore(join(dir, 'github-auth.enc'), storage)
  if (options.signedIn) await tokenStore.write(options.signedIn)
  const session = await GitHubSession.load({
    store: tokenStore,
    fetch:
      options.fetch ??
      ((() => {
        throw new Error('unexpected network')
      }) as typeof fetch),
  })
  const mdxTrust = createMdxTrustStore(join(dir, 'mdx-trust.json'))
  const compile = vi.fn(async (_source: string) => [
    { message: 'unexpected token', line: 2, column: 4 },
  ])
  let selected: ActiveVault | null = null
  const runtimes = new Map<string, ActiveVault>()
  const makeActive = (remote: string): ActiveVault => {
    const existing = runtimes.get(remote)
    if (existing) return existing
    const runtime = {
      remote,
      root,
      snapshot: () => ({}) as never,
      refresh: async () => {},
    } as unknown as ActiveVault
    runtimes.set(remote, runtime)
    return runtime
  }
  const host = {
    active: () => selected,
    get: (remote: string) => runtimes.get(remote) ?? null,
    prepare: async () => {},
    open: async (remote: string) => (selected = makeActive(remote)),
    getOrOpen: async (remote: string) => makeActive(remote),
    close: async (remote = selected?.remote) => {
      if (remote === undefined) return
      runtimes.delete(remote)
      if (selected?.remote === remote) selected = null
    },
    remove: async (remote: string, afterClose?: () => Promise<void>) => {
      await host.close(remote)
      await afterClose?.()
      await registry.remove(remote)
    },
    closeAll: async () => {
      runtimes.clear()
      selected = null
    },
  } as unknown as VaultHost
  const plugins = {
    reconcile: async () => {},
    invalidate: () => {},
    setDisplayed: () => {},
    syncBackground: async () => {},
    failures: () => ({}),
    scanClaimsFor: async () => [],
  }
  const consentFile = join(dir, 'mdx-consent.json')
  const consent = createMdxConsentStore(consentFile)
  const changed: string[] = []
  let retireDocument = (_retireDocument?: boolean) => {}
  let shuttingDown = false
  const documentReady = options.document
    ? trackMdxDocument(options.document, (retire) => retireDocument(retire))
    : () => true
  const caller = createRouter({
    registry,
    session,
    mdxTrust: options.trust?.(mdxTrust) ?? mdxTrust,
    mdxConsent: options.consent?.(consent) ?? consent,
    mdxExternalFetch: options.externalFetch,
    mdxApplicationReady: () => !shuttingDown && documentReady(),
    onMdxDiagnosticsInvalidate: (invalidate) => {
      retireDocument = invalidate
    },
    onMdxResourcesChanged: (remote) => {
      changed.push(remote)
      options.onResourceChange?.()
    },
    mdxCompiler: {
      createOwner: () => ({}),
      retireOwner: vi.fn(),
      compile: vi.fn((_owner, source) => compile(source)),
      inspect:
        options.inspect ??
        (async (_owner, source) => ({
          diagnostics: await compile(source),
          dependencies: [],
        })),
      invalidate: vi.fn(),
      close: vi.fn(),
    },
    host,
    vaultRoot: join(dir, 'clones'),
    seed: async () => ({ written: [], merged: [], unchanged: [] }),
    plugins,
    prepareClone: async () => {},
    openExternal: async () => {},
    trashItem: async () => {},
    showItemInFolder: () => {},
  }).createCaller({})
  await caller.vaults.open({ remote: REMOTE })
  return {
    dir,
    root,
    registry,
    session,
    mdxTrust,
    caller,
    host,
    selected: () => selected,
    compile,
    consentFile,
    changed,
    retireDocument,
    shutdown: (
      proceed: () => Promise<boolean> = async () => {
        retireDocument(false)
        return true
      },
      reportBlocked: (error: unknown) => Promise<void> = async () => {},
    ) =>
      withMdxConsentQuit({
        consent,
        pauseAdmission: () => (shuttingDown = true),
        resumeAdmission: () => (shuttingDown = false),
        proceed,
        reportBlocked,
      }),
  }
}

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

export async function rig(options: Parameters<typeof fixture>[0] = {}) {
  const result = await fixture(options)
  dirs.push(result.dir)
  return result
}

// Use the real guest message interface and parser without launching Electron.
export async function resourceRig(
  useProductionFetcher = false,
  {
    holdInspection,
    ...options
  }: Pick<NonNullable<Parameters<typeof fixture>[0]>, 'onResourceChange' | 'consent'> & {
    holdInspection?: (signal: AbortSignal) => Promise<void>
  } = {},
) {
  await import('../../src/mdx-compiler/guest')
  type Result = Awaited<ReturnType<MdxResources['inspect']>>
  const guest = globalThis as typeof globalThis & {
    __holiMdxReceive(encoded: string): void
    __holiMdxTakeResult(): (Result & { id: string }) | null
  }
  let id = 0
  const contacts: string[] = []
  const routes = new Map<string, { redirect: string } | { text: string }>()
  const externalFetch: typeof fetchMdxExternalData = async ({ url, signal, assertAccess }) => {
    let target = new URL(url)
    for (let redirects = 0; redirects <= 3; redirects++) {
      signal.throwIfAborted()
      if (!(await assertAccess(target.origin, signal)))
        throw new MdxExternalDataError('consent-needed', target.origin)
      signal.throwIfAborted()
      contacts.push(target.href)
      const response = routes.get(target.href)
      if (!response) throw new MdxExternalDataError('response')
      if ('redirect' in response) target = new URL(response.redirect, target)
      else return { url: target.href, text: response.text }
    }
    throw new MdxExternalDataError('redirect')
  }
  const fixture = await rig({
    signedIn: auth(42, 'alice'),
    inspect: async (_owner, source, signal, format) => {
      const requestId = String(++id)
      guest.__holiMdxReceive(
        Buffer.from(JSON.stringify({ id: requestId, source, format })).toString('base64'),
      )
      for (;;) {
        signal?.throwIfAborted()
        const result = guest.__holiMdxTakeResult()
        if (result?.id === requestId) {
          if (holdInspection) await holdInspection(signal!)
          return result
        }
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    },
    externalFetch: useProductionFetcher ? undefined : externalFetch,
    ...options,
  })
  const mdx = fixture.caller.mdxTrust
  await writeFile(join(fixture.root, 'page.mdx'), '# source')
  const status = await mdx.status({ remote: REMOTE })
  await mdx.approve({ remote: REMOTE, context: status.context! })
  const acquire = async () => {
    const { context } = await mdx.status({ remote: REMOTE })
    return mdx.acquireDiagnosticsLease({ remote: REMOTE, path: 'page.mdx', context: context! })
  }
  return { ...fixture, mdx, acquire, contacts, routes }
}
