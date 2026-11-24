import { Resolver } from 'node:dns/promises'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRouter } from '../src/main/router'
import { GitHubSession } from '../src/main/github/session'
import { TokenStore, type SafeStorageLike, type StoredAuth } from '../src/main/github/token-store'
import { createMdxTrustStore, type MdxTrustStore } from '../src/main/mdx-trust'
import { createMdxConsentStore } from '../src/main/mdx-consent'
import { MdxExternalDataError, type fetchMdxExternalData } from '../src/main/mdx-external-data'
import type { MdxResources } from '../src/main/mdx-resources'
import { VaultRegistry } from '../src/main/vault/registry'
import type { ActiveVault, VaultHost } from '../src/main/vault/active-vault'

const storage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${Buffer.from(plain).toString('base64')}`),
  decryptString: (buf) => Buffer.from(buf.toString().slice(4), 'base64').toString(),
}
const auth = (accountId: number, login: string): StoredAuth => ({
  token: `token-${accountId}`,
  accountId,
  login,
  scopes: ['repo'],
})
const REMOTE = 'syv-ai/notes'
const gate = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

async function fixture(
  options: {
    signedIn?: StoredAuth
    fetch?: typeof fetch
    trust?: (store: MdxTrustStore) => MdxTrustStore
    inspect?: MdxResources['inspect']
    externalFetch?: typeof fetchMdxExternalData
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
  const makeActive = (remote: string): ActiveVault =>
    ({
      remote,
      root,
      snapshot: async () => ({}) as never,
      refresh: async () => {},
    }) as unknown as ActiveVault
  const host = {
    active: () => selected,
    get: () => null,
    prepare: async () => {},
    open: async (remote: string) => (selected = makeActive(remote)),
    getOrOpen: async (remote: string) => makeActive(remote),
    close: async () => {
      selected = null
    },
    closeAll: async () => {
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
  const changed: string[] = []
  let retireDocument = () => {}
  const caller = createRouter({
    registry,
    session,
    mdxTrust: options.trust?.(mdxTrust) ?? mdxTrust,
    mdxConsent: createMdxConsentStore(consentFile),
    mdxExternalFetch: options.externalFetch,
    onMdxDiagnosticsInvalidate: (invalidate) => {
      retireDocument = invalidate
    },
    onMdxResourcesChanged: (remote) => changed.push(remote),
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
  }
}

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function rig(options: Parameters<typeof fixture>[0] = {}) {
  const result = await fixture(options)
  dirs.push(result.dir)
  return result
}

describe('MDX trust through the router', () => {
  it('resolves mixed-case registered remotes to the active managed root', async () => {
    const { caller, registry } = await rig({ signedIn: auth(42, 'alice') })
    const root = (await registry.list())[0]!.path
    await registry.remove(REMOTE)
    await registry.add({
      remote: 'SYV-AI/NOTES',
      path: root,
      name: 'notes',
      lastOpenedAt: '2026-01-01',
    })
    await expect(caller.mdxTrust.status({ remote: REMOTE })).resolves.toMatchObject({
      trusted: false,
      identityAvailable: true,
    })
  })

  it('reports signed-out and missing-token identity without exposing a trust context', async () => {
    const { caller } = await rig()
    await expect(caller.mdxTrust.status({ remote: REMOTE })).resolves.toEqual({
      trusted: false,
      identityAvailable: false,
      context: null,
    })
  })

  it('binds approval and revocation to a signed-in account and canonical registered remote across restart', async () => {
    const { caller, dir } = await rig({ signedIn: auth(42, 'alice') })
    const status = await caller.mdxTrust.status({ remote: 'https://github.com/SYV-AI/NOTES.git' })
    expect(status).toMatchObject({ trusted: false, identityAvailable: true })
    await caller.mdxTrust.approve({ remote: REMOTE, context: status.context! })
    expect(await caller.mdxTrust.status({ remote: REMOTE })).toMatchObject({ trusted: true })

    const restarted = createMdxTrustStore(join(dir, 'mdx-trust.json'))
    expect(
      await restarted.status({ accountId: '42', remote: 'git@github.com:SYV-AI/NOTES.git' }),
    ).toBe(true)
    const trusted = await caller.mdxTrust.status({ remote: REMOTE })
    await caller.mdxTrust.revoke({ remote: REMOTE, context: trusted.context! })
    expect(await caller.mdxTrust.status({ remote: REMOTE })).toMatchObject({ trusted: false })
  })

  it('compiles approved MDX through a view-scoped lease', async () => {
    const { caller, compile, registry } = await rig({ signedIn: auth(42, 'alice') })
    const status = await caller.mdxTrust.status({ remote: REMOTE })
    await expect(
      caller.mdxTrust.acquireDiagnosticsLease({
        remote: REMOTE,
        path: 'page.mdx',
        context: status.context!,
      }),
    ).rejects.toThrow()
    expect(compile).not.toHaveBeenCalled()
    await caller.mdxTrust.approve({ remote: REMOTE, context: status.context! })
    const trusted = await caller.mdxTrust.status({ remote: REMOTE })
    const root = (await registry.list()).find((entry) => entry.remote === REMOTE)!.path
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'page.mdx'), '# source')
    const first = await caller.mdxTrust.acquireDiagnosticsLease({
      remote: REMOTE,
      path: 'page.mdx',
      context: trusted.context!,
    })
    const second = await caller.mdxTrust.acquireDiagnosticsLease({
      remote: REMOTE,
      path: 'page.mdx',
      context: trusted.context!,
    })
    expect(first.lease).not.toBe(second.lease)
    await expect(
      caller.mdxTrust.acquireDiagnosticsLease({
        remote: REMOTE,
        path: 'USER.local.mdx',
        context: trusted.context!,
      }),
    ).rejects.toThrow()
    const third = await caller.mdxTrust.acquireDiagnosticsLease({
      remote: REMOTE,
      path: 'page.mdx',
      context: trusted.context!,
    })
    const fourth = await caller.mdxTrust.acquireDiagnosticsLease({
      remote: REMOTE,
      path: 'page.mdx',
      context: trusted.context!,
    })
    await expect(
      caller.mdxTrust.acquireDiagnosticsLease({
        remote: REMOTE,
        path: 'page.mdx',
        context: trusted.context!,
      }),
    ).rejects.toThrow()
    await expect(
      caller.mdxTrust.compile({
        lease: first.lease,
        generation: 1,
        source: 'x'.repeat(256 * 1024 + 1),
      }),
    ).rejects.toThrow()
    await expect(
      caller.mdxTrust.compile({ lease: first.lease, generation: 1, source: '# Source' }),
    ).resolves.toEqual([{ message: 'unexpected token', line: 2, column: 4 }])
    expect(compile).toHaveBeenCalledWith('# Source')
    await expect(
      caller.mdxTrust.cancelCompile({ lease: first.lease, generation: 2 }),
    ).resolves.toEqual({ ok: true })
    await expect(
      caller.mdxTrust.compile({ lease: first.lease, generation: 2, source: '# retry' }),
    ).resolves.toEqual([{ message: 'unexpected token', line: 2, column: 4 }])
    await expect(
      caller.mdxTrust.compile({ lease: first.lease, generation: 1, source: '# old' }),
    ).rejects.toThrow()
    await caller.mdxTrust.releaseDiagnosticsLease({ lease: first.lease })
    await expect(
      caller.mdxTrust.compile({ lease: first.lease, generation: 3, source: '# released' }),
    ).rejects.toThrow()
    await caller.mdxTrust.releaseDiagnosticsLease({ lease: second.lease })
    await caller.mdxTrust.releaseDiagnosticsLease({ lease: third.lease })
    await caller.mdxTrust.releaseDiagnosticsLease({ lease: fourth.lease })
    const replaced = await caller.mdxTrust.acquireDiagnosticsLease({
      remote: REMOTE,
      path: 'page.mdx',
      context: trusted.context!,
    })
    const callsBeforeReplacement = compile.mock.calls.length
    await writeFile(join(root, 'page.mdx'), '# replaced source with changed fingerprint')
    await expect(
      caller.mdxTrust.compile({
        lease: replaced.lease,
        generation: 1,
        source: '# must not compile',
      }),
    ).rejects.toThrow()
    expect(compile).toHaveBeenCalledTimes(callsBeforeReplacement)
  })

  it('rejects unregistered remotes', async () => {
    const { caller } = await rig({ signedIn: auth(42, 'alice') })
    await expect(caller.mdxTrust.status({ remote: 'syv-ai/other' })).rejects.toThrow(
      /Vault context changed/,
    )
  })

  it('invalidates contexts on logout and account-generation changes, including same-account relogin', async () => {
    const { caller, session } = await rig({ signedIn: auth(42, 'alice') })
    const first = await caller.mdxTrust.status({ remote: REMOTE })
    await session.signOut()
    await expect(
      caller.mdxTrust.approve({ remote: REMOTE, context: first.context! }),
    ).rejects.toThrow(/context changed/)
    // A newly loaded authenticated session is a distinct generation; contexts cannot cross it.
    const second = await caller.mdxTrust.status({ remote: REMOTE })
    expect(second.identityAvailable).toBe(false)
  })

  it('invalidates contexts on account change and same-account relogin generations', async () => {
    const grants = ['grant-43', 'grant-42']
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/login/device/code'))
        return Response.json({
          device_code: 'device',
          user_code: 'CODE',
          verification_uri: 'https://github.com/login/device',
          expires_in: 600,
          interval: 1,
        })
      if (url.endsWith('/login/oauth/access_token'))
        return Response.json({ access_token: grants.shift(), scope: 'repo' })
      if (url.endsWith('/user')) {
        const bearer = new Headers(init?.headers).get('Authorization') ?? ''
        const accountId = bearer.includes('grant-43') ? 43 : 42
        return Response.json({
          id: accountId,
          login: accountId === 43 ? 'bob' : 'alice',
          name: null,
          avatar_url: null,
        })
      }
      throw new Error(`unexpected URL ${url}`)
    }) as typeof globalThis.fetch
    const { caller, session } = await rig({ signedIn: auth(42, 'alice'), fetch })
    const original = await caller.mdxTrust.status({ remote: REMOTE })
    const first = await session.signIn()
    await first.wait()
    await expect(
      caller.mdxTrust.approve({ remote: REMOTE, context: original.context! }),
    ).rejects.toThrow(/context changed/)

    const afterAccountChange = await caller.mdxTrust.status({ remote: REMOTE })
    const second = await session.signIn()
    await second.wait()
    await expect(
      caller.mdxTrust.approve({ remote: REMOTE, context: afterAccountChange.context! }),
    ).rejects.toThrow(/context changed/)
  })

  it('rejects a token after A→B→A opens', async () => {
    const { caller, registry, dir } = await rig({ signedIn: auth(42, 'alice') })
    const token = await caller.mdxTrust.status({ remote: REMOTE })
    await registry.add({
      remote: 'syv-ai/other',
      path: join(dir, 'other'),
      name: 'other',
      lastOpenedAt: '2026-01-01',
    })
    await caller.vaults.open({ remote: 'syv-ai/other' })
    await caller.vaults.open({ remote: REMOTE })
    await expect(
      caller.mdxTrust.approve({ remote: REMOTE, context: token.context! }),
    ).rejects.toThrow(/context changed/)
  })

  it('rejects a status requested while a vault open is pending', async () => {
    const { caller, host } = await rig({ signedIn: auth(42, 'alice') })
    const pending = gate<ActiveVault>()
    vi.spyOn(host, 'open').mockReturnValueOnce(pending.promise)
    const opening = caller.vaults.open({ remote: REMOTE })
    await expect(caller.mdxTrust.status({ remote: REMOTE })).rejects.toThrow(
      /Vault context changed/,
    )
    pending.resolve(host.active()!)
    await opening
  })

  it('rejects a late status when account context changes during registry lookup', async () => {
    const { caller, registry, session } = await rig({ signedIn: auth(42, 'alice') })
    const read = gate<void>()
    const entered = gate<void>()
    const list = registry.list.bind(registry)
    vi.spyOn(registry, 'list').mockImplementation(async () => {
      entered.resolve()
      await read.promise
      return list()
    })
    const request = caller.mdxTrust.status({ remote: REMOTE })
    const rejected = expect(request).rejects.toThrow(/context changed/)
    await entered.promise
    await session.signOut()
    read.resolve()
    await rejected
  })

  it('waits for registry and store work, then refuses mutations after context loss', async () => {
    const { caller, registry, session, dir } = await rig({ signedIn: auth(42, 'alice') })
    const status = await caller.mdxTrust.status({ remote: REMOTE })
    const read = gate<void>()
    const entered = gate<void>()
    const list = registry.list.bind(registry)
    vi.spyOn(registry, 'list').mockImplementation(async () => {
      entered.resolve()
      await read.promise
      return list()
    })
    const update = caller.mdxTrust.approve({ remote: REMOTE, context: status.context! })
    const rejected = expect(update).rejects.toThrow(/context changed/)
    await entered.promise
    await session.signOut()
    read.resolve()
    await rejected
    expect(
      await createMdxTrustStore(join(dir, 'mdx-trust.json')).status({
        accountId: '42',
        remote: REMOTE,
      }),
    ).toBe(false)
  })

  it('rechecks ownership after a delayed trust-store mutation', async () => {
    const entered = gate<void>()
    const release = gate<void>()
    const { caller, session, dir } = await rig({
      signedIn: auth(42, 'alice'),
      trust: (store) => ({
        status: (owner) => store.status(owner),
        approve: async (owner, stillOwned) => {
          entered.resolve()
          await release.promise
          await store.approve(owner, stillOwned)
        },
        revoke: (owner, stillOwned) => store.revoke(owner, stillOwned),
      }),
    })
    const status = await caller.mdxTrust.status({ remote: REMOTE })
    const update = caller.mdxTrust.approve({ remote: REMOTE, context: status.context! })
    const rejected = expect(update).rejects.toThrow(/context changed/)
    await entered.promise
    await session.signOut()
    release.resolve()
    await rejected
    expect(
      await createMdxTrustStore(join(dir, 'mdx-trust.json')).status({
        accountId: '42',
        remote: REMOTE,
      }),
    ).toBe(false)
  })

  it('invalidates a note lease before replacing its source', async () => {
    const { caller, registry } = await rig({ signedIn: auth(42, 'alice') })
    const root = (await registry.list())[0]!.path
    await writeFile(join(root, 'page.mdx'), '# before')
    const pending = await caller.mdxTrust.status({ remote: REMOTE })
    await caller.mdxTrust.approve({ remote: REMOTE, context: pending.context! })
    const trusted = await caller.mdxTrust.status({ remote: REMOTE })
    const lease = await caller.mdxTrust.acquireDiagnosticsLease({
      remote: REMOTE,
      path: 'page.mdx',
      context: trusted.context!,
    })
    await caller.notes.write({ remote: REMOTE, path: 'page.mdx', text: '# after' })
    await expect(
      caller.mdxTrust.compile({ lease: lease.lease, generation: 1, source: '# stale' }),
    ).rejects.toThrow()
    await expect(caller.mdxTrust.status({ remote: REMOTE })).resolves.toMatchObject({
      trusted: true,
      identityAvailable: true,
    })
  })

  it('retires compile authority before a revoke waits for registry lookup', async () => {
    const { caller, registry } = await rig({ signedIn: auth(42, 'alice') })
    const untrusted = await caller.mdxTrust.status({ remote: REMOTE })
    await caller.mdxTrust.approve({ remote: REMOTE, context: untrusted.context! })
    const trusted = await caller.mdxTrust.status({ remote: REMOTE })
    const root = (await registry.list())[0]!.path
    await writeFile(join(root, 'page.mdx'), '# source')
    const lease = await caller.mdxTrust.acquireDiagnosticsLease({
      remote: REMOTE,
      path: 'page.mdx',
      context: trusted.context!,
    })
    const read = gate<void>()
    const entered = gate<void>()
    const list = registry.list.bind(registry)
    vi.spyOn(registry, 'list').mockImplementation(async () => {
      entered.resolve()
      await read.promise
      return list()
    })
    const revoking = caller.mdxTrust.revoke({ remote: REMOTE, context: trusted.context! })
    await entered.promise
    await expect(
      caller.mdxTrust.compile({ lease: lease.lease, generation: 1, source: '# old source' }),
    ).rejects.toThrow()
    read.resolve()
    await revoking
    await expect(
      caller.mdxTrust.compile({ lease: lease.lease, generation: 2, source: '# old source again' }),
    ).rejects.toThrow()
    await expect(caller.mdxTrust.status({ remote: REMOTE })).resolves.toMatchObject({
      trusted: false,
      identityAvailable: true,
    })
  })

  it('blocks status and acquisition throughout a pending revoke, then recovers via fresh status', async () => {
    const entered = gate<void>()
    const release = gate<void>()
    const { caller, mdxTrust } = await rig({
      signedIn: auth(42, 'alice'),
      trust: (store) => ({
        status: (owner) => store.status(owner),
        approve: (owner, stillOwned) => store.approve(owner, stillOwned),
        revoke: async (owner, stillOwned) => {
          entered.resolve()
          await release.promise
          await store.revoke(owner, stillOwned)
        },
      }),
    })
    const initial = await caller.mdxTrust.status({ remote: REMOTE })
    await caller.mdxTrust.approve({ remote: REMOTE, context: initial.context! })
    const trusted = await caller.mdxTrust.status({ remote: REMOTE })
    const revoking = caller.mdxTrust.revoke({ remote: REMOTE, context: trusted.context! })
    await entered.promise
    await expect(caller.mdxTrust.status({ remote: REMOTE })).rejects.toThrow(/context changed/i)
    await expect(
      caller.mdxTrust.acquireDiagnosticsLease({
        remote: REMOTE,
        path: 'page.mdx',
        context: trusted.context!,
      }),
    ).rejects.toThrow()
    release.resolve()
    await revoking
    await expect(caller.mdxTrust.status({ remote: REMOTE })).resolves.toMatchObject({
      trusted: false,
      identityAvailable: true,
    })
    expect(await mdxTrust.status({ accountId: '42', remote: REMOTE })).toBe(false)
  })

  it('does not invalidate an earlier context when another status request completes', async () => {
    const { caller } = await rig({ signedIn: auth(42, 'alice') })
    const earlier = await caller.mdxTrust.status({ remote: REMOTE })
    const later = await caller.mdxTrust.status({ remote: REMOTE })
    expect(later.context).toBe(earlier.context)
    await expect(
      caller.mdxTrust.approve({ remote: REMOTE, context: earlier.context! }),
    ).resolves.toEqual({ trusted: true })
  })
})

it('refuses a missing or forged consent context without persisting a grant', async () => {
  const { caller, mdxTrust } = await rig({ signedIn: auth(42, 'alice') })
  await expect(caller.mdxTrust.approve({ remote: REMOTE, context: '' })).rejects.toThrow(/context/)
  await expect(caller.mdxTrust.approve({ remote: REMOTE } as never)).rejects.toThrow()
  expect(await mdxTrust.status({ accountId: '42', remote: REMOTE })).toBe(false)
})

it('keeps the validated identity pending adoption and retires its context on publication', async () => {
  const entered = gate<void>()
  const finish = gate<void>()
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/login/device/code'))
      return Response.json({
        device_code: 'fixture',
        user_code: 'CODE',
        verification_uri: 'https://github.com/login/device',
        expires_in: 600,
        interval: 1,
      })
    if (url.endsWith('/login/oauth/access_token'))
      return Response.json({ access_token: 'fixture-token', scope: 'repo' })
    if (url.endsWith('/user')) {
      entered.resolve()
      await finish.promise
      return Response.json({ id: 43, login: 'other', name: null, avatar_url: null })
    }
    throw new Error('Unexpected network')
  }) as typeof globalThis.fetch
  const { caller, session } = await rig({ signedIn: auth(42, 'alice'), fetch })
  const flow = await session.signIn()
  const adopting = flow.wait()
  await entered.promise
  const pending = await caller.mdxTrust.status({ remote: REMOTE })
  expect(pending).toMatchObject({ trusted: false, identityAvailable: true })
  expect(pending.context).toBeTruthy()
  finish.resolve()
  await adopting
  await expect(
    caller.mdxTrust.approve({ remote: REMOTE, context: pending.context! }),
  ).rejects.toThrow(/context changed/)
  expect(await caller.mdxTrust.status({ remote: REMOTE })).toMatchObject({
    trusted: false,
    identityAvailable: true,
  })
})

// Use the real guest message interface and parser without launching Electron.
async function resourceRig(useProductionFetcher = false) {
  await import('../src/mdx-compiler/guest')
  type Result = Awaited<ReturnType<MdxResources['inspect']>>
  const guest = globalThis as typeof globalThis & {
    __holiMdxReceive(encoded: string): void
    __holiMdxTakeResult(): (Result & { id: string }) | null
  }
  let id = 0
  const contacts: string[] = []
  const routes = new Map<string, { redirect: string } | { text: string }>()
  let hold: {
    started: ReturnType<typeof gate<void>>
    cancelled: ReturnType<typeof gate<void>>
  } | null = null
  const externalFetch: typeof fetchMdxExternalData = async ({ url, signal, assertAccess }) => {
    let target = new URL(url)
    for (let redirects = 0; redirects <= 3; redirects++) {
      signal.throwIfAborted()
      if (!(await assertAccess(target.origin, signal)))
        throw new MdxExternalDataError('consent-needed', target.origin)
      signal.throwIfAborted()
      contacts.push(target.href)
      const held = hold
      if (held) {
        hold = null
        return new Promise((_, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              held.cancelled.resolve()
              reject(new MdxExternalDataError('aborted'))
            },
            { once: true },
          )
          held.started.resolve()
        })
      }
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
        if (result?.id === requestId) return result
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    },
    externalFetch: useProductionFetcher ? undefined : externalFetch,
  })
  const mdx = fixture.caller.mdxTrust
  await writeFile(join(fixture.root, 'page.mdx'), '# source')
  const status = await mdx.status({ remote: REMOTE })
  await mdx.approve({ remote: REMOTE, context: status.context! })
  const acquire = async () => {
    const { context } = await mdx.status({ remote: REMOTE })
    return mdx.acquireDiagnosticsLease({ remote: REMOTE, path: 'page.mdx', context: context! })
  }
  const stallContact = () => {
    hold = { started: gate(), cancelled: gate() }
    return { started: hold.started.promise, cancelled: hold.cancelled.promise }
  }
  return { ...fixture, mdx, acquire, contacts, routes, stallContact }
}

const entry = 'https://one.example/entry.js'
const externalSource = `import '${entry}?opaque=value'\n`

it('opens a consent request for the production fetcher without resolving DNS', async () => {
  const { acquire, mdx } = await resourceRig(true)
  const dns4 = vi.spyOn(Resolver.prototype, 'resolve4').mockRejectedValue({ code: 'ENODATA' })
  const dns6 = vi.spyOn(Resolver.prototype, 'resolve6').mockRejectedValue({ code: 'ENODATA' })
  const owner = await acquire()
  try {
    expect(await mdx.compile({ ...owner, generation: 1, source: externalSource })).toHaveLength(1)
    expect((await mdx.externalResources(owner)).pending).toMatchObject([
      { origin: 'https://one.example' },
    ])
    expect(dns4).not.toHaveBeenCalled()
    expect(dns6).not.toHaveBeenCalled()
  } finally {
    await mdx.releaseDiagnosticsLease(owner)
    dns4.mockRestore()
    dns6.mockRestore()
  }
})

it('requires separate consent for a static import, its redirect, and a transitive external re-export', async () => {
  const { root, mdx, acquire, contacts, routes, changed } = await resourceRig()
  const owner = await acquire()
  const secondView = await acquire()
  const source = `${externalSource}import './local.js'\n`
  await writeFile(join(root, 'local.js'), 'export const local = 1')
  const redirected = 'https://two.example/lib/main.mjs'
  const child = 'https://two.example/lib/child.js'
  const transit = 'https://three.example/leaf.js'
  routes.set(`${entry}?opaque=value`, { redirect: redirected })
  routes.set(redirected, { text: "export * from './child.js'" })
  routes.set(child, { text: `export * from '${transit}'` })
  routes.set(transit, { text: 'export const leaf = 3' })
  const diagnose = (generation: number) => mdx.compile({ ...owner, generation, source })
  await mdx.compile({ ...secondView, generation: 1, source })
  for (const [index, origin] of [
    'https://one.example',
    'https://two.example',
    'https://three.example',
  ].entries()) {
    const generation = index + 1
    expect(await diagnose(generation)).not.toHaveLength(0)
    const control = await mdx.externalResources(owner)
    expect(control).toMatchObject({
      generation,
      pending: [{ origin, purpose: 'mdx-dependency-diagnostics' }],
    })
    expect(control.approved).toHaveLength(index)
    expect(JSON.stringify(control)).not.toContain('opaque=value')
    expect(contacts.some((url) => new URL(url).origin === origin)).toBe(false)
    const requestId = control.pending[0]!.id
    await expect(mdx.approveExternalResource({ ...secondView, requestId })).rejects.toThrow()
    if (index === 0) {
      const splitId = (await mdx.externalResources(secondView)).pending[0]!.id
      const granted = await Promise.allSettled([
        mdx.approveExternalResource({ ...owner, requestId }),
        mdx.approveExternalResource({ ...secondView, requestId: splitId }),
      ])
      expect(granted.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    } else {
      await mdx.approveExternalResource({ ...owner, requestId })
    }
    expect((await mdx.externalResources(secondView)).pending).toEqual([])
  }
  expect(changed).toEqual([REMOTE, REMOTE, REMOTE])
  expect(await diagnose(4)).toEqual([])
  expect(contacts).toContain(child)
  expect(contacts).not.toContain('https://one.example/child.js')

  routes.set(child, {
    text: "import './style.css'; import 'some-package'; import('./dynamic.js'); module.exports = 1",
  })
  expect(await diagnose(5)).toHaveLength(4)
  expect((await mdx.externalResources(owner)).pending).toEqual([])
  expect(contacts).not.toContain('https://two.example/lib/style.css')
  expect(contacts).not.toContain('https://two.example/lib/dynamic.js')

  await mdx.releaseDiagnosticsLease(owner)
  await mdx.releaseDiagnosticsLease(secondView)
})

it('retires requests on rejection, edits, saves, document replacement and vault reopen', async () => {
  const { caller, mdx, acquire, contacts, retireDocument, registry, root, session } =
    await resourceRig()
  let owner = await acquire()
  const pending = async (generation: number) => {
    await mdx.compile({ ...owner, generation, source: externalSource })
    return { ...owner, requestId: (await mdx.externalResources(owner)).pending[0]!.id }
  }
  const rejected = await pending(1)
  await mdx.rejectExternalResource(rejected)
  expect((await mdx.externalResources(owner)).pending).toEqual([])
  await expect(mdx.approveExternalResource(rejected)).rejects.toThrow()
  const edited = await pending(2)
  const staleApproval = expect(mdx.approveExternalResource(edited)).rejects.toThrow()
  await mdx.cancelCompile({ ...owner, generation: 3 })
  await staleApproval
  expect((await mdx.externalResources(owner)).approved).toEqual([])
  const saved = await pending(3)
  await caller.notes.write({ remote: REMOTE, path: 'page.mdx', text: '# saved independently' })
  await expect(mdx.approveExternalResource(saved)).rejects.toThrow()
  owner = await acquire()
  const previousDocument = await pending(1)
  retireDocument()
  await expect(mdx.approveExternalResource(previousDocument)).rejects.toThrow()
  owner = await acquire()
  const previousOpen = await pending(1)
  const otherRemote = 'syv-ai/other'
  await registry.add({ remote: otherRemote, path: root, name: 'other', lastOpenedAt: '2026-01-01' })
  await caller.vaults.open({ remote: otherRemote })
  await caller.vaults.open({ remote: REMOTE })
  await expect(mdx.approveExternalResource(previousOpen)).rejects.toThrow()
  owner = await acquire()
  const previousAccount = await pending(1)
  await session.signOut()
  await expect(mdx.approveExternalResource(previousAccount)).rejects.toThrow()
  await expect(mdx.externalResources(owner)).rejects.toThrow()
  expect(contacts).toEqual([])
})

it('cannot contact an origin after failed approval or failed revocation, and aborts active access', async () => {
  const { mdx, acquire, consentFile, contacts, stallContact } = await resourceRig()
  const owner = await acquire()
  const other = await acquire()
  const compile = (generation: number) =>
    mdx.compile({ ...owner, generation, source: externalSource })
  await compile(1)
  const descriptor = (await mdx.externalResources(owner)).pending[0]!
  const approval = { ...owner, requestId: descriptor.id }
  await mkdir(consentFile) // A real filesystem failure, even if tests are run as root.
  await expect(mdx.approveExternalResource(approval)).rejects.toThrow()
  await rm(consentFile, { recursive: true })
  await compile(2)
  expect(contacts).toEqual([])
  await mdx.approveExternalResource({
    ...owner,
    requestId: (await mdx.externalResources(owner)).pending[0]!.id,
  })
  const grant = (await mdx.externalResources(other)).approved[0]!
  const stalled = stallContact()
  const compiling = expect(compile(3)).rejects.toThrow()
  await stalled.started
  // Make the store unreadable for the duration of revoke, then restore the old
  // on-disk grant. The running app must still deny it.
  const backup = `${consentFile}.backup`
  await rename(consentFile, backup)
  await mkdir(consentFile)
  await expect(mdx.revokeExternalResource({ ...other, grantId: grant.id })).rejects.toThrow()
  await stalled.cancelled
  await compiling
  await rm(consentFile, { recursive: true })
  await rename(backup, consentFile)
  await compile(4)
  expect(contacts).toEqual([`${entry}?opaque=value`])
  expect((await mdx.externalResources(owner)).approved).toEqual([])
  await mdx.releaseDiagnosticsLease(owner)
  await mdx.releaseDiagnosticsLease(other)
})
