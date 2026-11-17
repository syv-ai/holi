import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRouter } from '../src/main/router'
import { GitHubSession } from '../src/main/github/session'
import { TokenStore, type SafeStorageLike, type StoredAuth } from '../src/main/github/token-store'
import { createMdxTrustStore, type MdxTrustStore } from '../src/main/mdx-trust'
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
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'holi-mdx-router-'))
  const root = join(dir, 'vault')
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
  const compile = vi.fn(async () => [{ message: 'unexpected token', line: 2, column: 4 }])
  let selected: ActiveVault | null = null
  const makeActive = (remote: string): ActiveVault =>
    ({
      remote,
      snapshot: async () => ({}) as never,
    }) as ActiveVault
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
  const caller = createRouter({
    registry,
    session,
    mdxTrust: options.trust?.(mdxTrust) ?? mdxTrust,
    mdxCompiler: { compile, invalidate: vi.fn(), close: vi.fn() },
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
  return { dir, registry, session, mdxTrust, caller, host, selected: () => selected, compile }
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
    expect(compile).toHaveBeenCalledWith('# Source', expect.any(AbortSignal))
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

it('never mints consent for the provisional identity during account verification', async () => {
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
  try {
    expect(await caller.mdxTrust.status({ remote: REMOTE })).toEqual({
      trusted: false,
      identityAvailable: false,
      context: null,
    })
  } finally {
    finish.resolve()
    await adopting
  }
})
