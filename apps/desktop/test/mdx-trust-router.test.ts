import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createMdxTrustStore } from '../src/main/mdx-trust'
import type { ActiveVault } from '../src/main/vault/active-vault'
import { auth, REMOTE, gate, rig } from './fixtures/mdx-router'

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
