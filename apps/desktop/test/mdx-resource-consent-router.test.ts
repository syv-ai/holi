import { Resolver } from 'node:dns/promises'
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { createMdxConsentStore } from '../src/main/mdx-consent'
import { createMdxExternalNetworkFixture } from './fixtures/mdx-external-network'
import { fixtureResult, within } from './fixtures/fixture-deadline'
import { REMOTE, gate, resourceRig } from './fixtures/mdx-router'

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

it('persists concurrently approved distinct origins from two splits on the same source', async () => {
  const { mdx, acquire, routes } = await resourceRig()
  const one = await acquire()
  const two = await acquire()
  const secondEntry = 'https://two.example/lib.js'
  const source = `${externalSource}import '${secondEntry}'\n`
  routes.set(`${entry}?opaque=value`, { text: 'export const x = 1' })
  routes.set(secondEntry, { text: 'export const y = 2' })
  const compile = (owner: { lease: string }, generation: number) =>
    mdx.compile({ ...owner, generation, source })
  await compile(one, 1)
  await compile(two, 1)
  const approve = async (owner: { lease: string }, origin: string) => {
    const { pending } = await mdx.externalResources(owner)
    return { ...owner, requestId: pending.find((request) => request.origin === origin)!.id }
  }
  const first = await approve(one, 'https://one.example')
  const second = await approve(two, 'https://two.example')
  await expect(
    Promise.all([mdx.approveExternalResource(first), mdx.approveExternalResource(second)]),
  ).resolves.toEqual([{ ok: true }, { ok: true }])
  await expect(compile(one, 2)).resolves.toEqual([])
  expect(await mdx.externalResources(two)).toMatchObject({
    pending: [],
    approved: [{ origin: 'https://one.example' }, { origin: 'https://two.example' }],
  })
  await mdx.releaseDiagnosticsLease(one)
  await mdx.releaseDiagnosticsLease(two)
})

it('publishes the first grant read across compile startup and can revoke while inspection is held', async () => {
  const inspecting = gate()
  const { mdx, acquire, root, consentFile } = await resourceRig(true, {
    holdInspection: (signal) => {
      signal.throwIfAborted()
      const held = new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      inspecting.resolve()
      return held
    },
  })
  const scope = {
    root: await realpath(root),
    remote: REMOTE,
    accountId: '42',
    origin: new URL(entry).origin,
  }
  await createMdxConsentStore(consentFile).grant(scope)
  const owner = await acquire()
  // Start both routes in the same turn: the first grant read must await real
  // filesystem I/O while compile retires the source, before native inspection.
  const reading = mdx.externalResources(owner)
  const compiling = mdx.compile({ ...owner, generation: 1, source: externalSource }).then(
    () => 'completed',
    () => 'cancelled',
  )
  try {
    const [{ approved, pending }] = await Promise.all([
      within(reading, 3_000, 'read the first grant list'),
      within(inspecting.promise, 3_000, 'hold the inspection response'),
    ])
    expect(pending).toEqual([])
    expect(approved).toMatchObject([{ origin: scope.origin }])
    await expect(
      mdx.revokeExternalResource({ ...owner, grantId: approved[0]!.id }),
    ).resolves.toEqual({ ok: true })
    await expect(within(compiling, 2_000, 'cancel inspection on revoke')).resolves.toBe('cancelled')
    expect(await createMdxConsentStore(consentFile).allows(scope)).toBe(false)
    expect((await mdx.externalResources(owner)).approved).toEqual([])
  } finally {
    await mdx.releaseDiagnosticsLease(owner)
    await compiling
  }
})

it('closes a streaming HTTPS response on revoke and retains the same blocked grant for a save retry', async () => {
  const { mdx, acquire, consentFile, root } = await resourceRig(true)
  const network = await createMdxExternalNetworkFixture()
  const owner = await acquire()
  const other = await acquire()
  const compile = (generation: number) =>
    mdx.compile({ ...owner, generation, source: externalSource })
  const scope = {
    root: await realpath(root),
    remote: REMOTE,
    accountId: '42',
    origin: new URL(entry).origin,
  }
  try {
    await compile(1)
    const approval = async () => ({
      ...owner,
      requestId: (await mdx.externalResources(owner)).pending[0]!.id,
    })
    const failedSave = await approval()
    await mkdir(consentFile) // A real filesystem failure, even if tests are run as root.
    await expect(mdx.approveExternalResource(failedSave)).rejects.toThrow()
    await rm(consentFile, { recursive: true })
    await compile(2)
    expect(network.dials).toEqual([])
    expect((await mdx.externalResources(owner)).approved).toEqual([])
    await mdx.approveExternalResource(await approval())

    const grant = (await mdx.externalResources(other)).approved[0]!
    const receiving = gate()
    const closed = gate()
    network.routes.respond = (req, res) => {
      req.socket.once('close', () => closed.resolve())
      res.write('export const partial = ', () => receiving.resolve())
    }
    const compiling = expect(compile(3)).rejects.toThrow()
    await within(receiving.promise, 3_000, 'receive first HTTPS chunk')
    // Make the store unreadable during revocation; the old grant remains on disk.
    const backup = `${consentFile}.backup`
    await rename(consentFile, backup)
    await mkdir(consentFile)
    const revoke = { ...other, grantId: grant.id }
    await Promise.all([
      expect(mdx.revokeExternalResource(revoke)).rejects.toThrow(/revocation could not be saved/),
      // An eventual transport timeout is not evidence of revocation-driven cancellation.
      within(closed.promise, 2_000, 'disconnect revoked HTTPS response'),
      compiling,
    ])
    const blocked = { ...grant, revocationPending: true }
    expect(await mdx.externalResources(other)).toMatchObject({
      approved: [blocked],
      listError: expect.any(String),
    })
    await rm(consentFile, { recursive: true })
    await rename(backup, consentFile)
    expect(await createMdxConsentStore(consentFile).allows(scope)).toBe(true)
    await compile(4)
    expect(await mdx.externalResources(other)).toMatchObject({ approved: [blocked] })
    expect((await mdx.externalResources(owner)).pending).toEqual([])
    await expect(mdx.revokeExternalResource(revoke)).resolves.toEqual({ ok: true })
    expect(await createMdxConsentStore(consentFile).allows(scope)).toBe(false)
    await compile(5)
    expect(await mdx.externalResources(owner)).toMatchObject({
      approved: [],
      pending: [{ origin: grant.origin }],
    })
    expect(network.requests.map(({ url }) => url)).toEqual(['/entry.js?opaque=value'])
  } finally {
    await mdx.releaseDiagnosticsLease(owner)
    await mdx.releaseDiagnosticsLease(other)
    await network.close()
  }
})

it('keeps both origins revocable while the saved grant list is corrupt, without fetching', async () => {
  const { mdx, acquire, consentFile, root } = await resourceRig(true)
  const owner = await acquire()
  const scope = { root: await realpath(root), remote: REMOTE, accountId: '42' }
  const first = { ...scope, origin: new URL(entry).origin }
  const second = { ...scope, origin: 'https://two.example' }
  const stored = createMdxConsentStore(consentFile)
  await stored.grant(first)
  await stored.grant(second)
  const disk = await readFile(consentFile)
  const dns4 = vi.spyOn(Resolver.prototype, 'resolve4').mockRejectedValue({ code: 'ENODATA' })
  const dns6 = vi.spyOn(Resolver.prototype, 'resolve6').mockRejectedValue({ code: 'ENODATA' })
  const source = `${externalSource}import '${second.origin}/lib.js'\n`
  const revoke = (grant: { id: string }) =>
    mdx.revokeExternalResource({ ...owner, grantId: grant.id })
  try {
    const initial = await mdx.externalResources(owner)
    expect(initial.listError).toBeUndefined()
    const [a, b] = initial.approved
    expect([a?.origin, b?.origin]).toEqual([first.origin, second.origin])

    await writeFile(consentFile, '{')
    await expect(revoke(a!)).rejects.toThrow(/revocation could not be saved/)
    expect(await mdx.compile({ ...owner, generation: 1, source })).toHaveLength(2)
    expect(dns4).not.toHaveBeenCalled()
    expect(dns6).not.toHaveBeenCalled()
    expect(await mdx.externalResources(owner)).toMatchObject({
      listError: expect.any(String),
      pending: [],
      approved: [{ ...a, revocationPending: true }, b],
    })
    // The original ID is accepted while storage is down; only saving the removal fails.
    await expect(revoke(b!)).rejects.toThrow(/revocation could not be saved/)

    await writeFile(consentFile, disk)
    expect(await stored.allows(first)).toBe(true)
    expect(await stored.allows(second)).toBe(true)
    await expect(revoke(a!)).resolves.toEqual({ ok: true })
    await expect(revoke(b!)).resolves.toEqual({ ok: true })
    expect(await stored.allows(first)).toBe(false)
    expect(await stored.allows(second)).toBe(false)
    const repaired = await mdx.externalResources(owner)
    expect(repaired.listError).toBeUndefined()
    expect(repaired.approved).toEqual([])
  } finally {
    await mdx.releaseDiagnosticsLease(owner)
    dns4.mockRestore()
    dns6.mockRestore()
  }
})

it('refreshes a second split after a grant read queued behind a revocation becomes stale', async () => {
  const finishWrite = gate()
  const listQueued = gate()
  let onChange = () => {}
  const { mdx, acquire, root, consentFile, contacts, routes } = await resourceRig(false, {
    onResourceChange: () => onChange(),
    consent: (store) => {
      let saving: Promise<void> | undefined
      return {
        ...store,
        revoke(scope) {
          // Model a held write, not a stalled OS call. The real store still
          // persists the removal and notifies listeners before releasing reads.
          saving = finishWrite.promise
            .then(() => store.revoke(scope))
            .finally(() => {
              saving = undefined
            })
          return saving
        },
        async listGrants(owner) {
          if (saving) {
            listQueued.resolve()
            await saving.catch(() => undefined)
          }
          return store.listGrants(owner)
        },
      }
    },
  })
  const scope = { root: await realpath(root), remote: REMOTE, accountId: '42' }
  const revoked = { ...scope, origin: new URL(entry).origin }
  const independent = 'https://two.example/still-allowed.js'
  const stored = createMdxConsentStore(consentFile)
  await stored.grant(revoked)
  await stored.grant({ ...scope, origin: new URL(independent).origin })
  routes.set(independent, { text: 'export const value = true' })
  const revoker = await acquire()
  const split = await acquire()
  type Resources = Awaited<ReturnType<typeof mdx.externalResources>>
  const initialRead = fixtureResult<Resources>()
  const freshRead = fixtureResult<Resources>()
  const refreshes: Promise<void>[] = []
  let generation = 0
  let removal: ReturnType<typeof mdx.revokeExternalResource> | undefined
  try {
    const grant = (await mdx.externalResources(revoker)).approved[0]!
    const [obsolete, independentGrant] = (await mdx.externalResources(split)).approved
    expect(obsolete?.origin).toBe(revoked.origin)
    expect(independentGrant?.origin).toBe(new URL(independent).origin)

    onChange = () => {
      const next = ++generation
      const read = next === 1 ? initialRead : freshRead
      // The second split reads on diagnostic completion. Local-only diagnostics
      // can finish while the grant list still has to wait for the store queue.
      refreshes.push(
        mdx
          .compile({ ...split, generation: next, source: '# Local diagnostics' })
          .then(() => mdx.externalResources(split))
          .then(
            (value) => read.settle({ value }),
            (error: unknown) => read.settle({ error }),
          ),
      )
    }
    removal = mdx.revokeExternalResource({ ...revoker, grantId: grant.id })
    void removal.catch(() => undefined)
    await within(listQueued.promise, 3_000, 'queue the second split grant read after diagnostics')
    expect(await stored.allows(revoked)).toBe(true)
    finishWrite.resolve()

    await expect(removal).resolves.toEqual({ ok: true })
    await expect(initialRead.wait(3_000, 'discard the pre-save read')).rejects.toThrow()
    // Only the router push can start this refresh; there is no manual Retry.
    const refreshed = await freshRead.wait(3_000, 'refresh the second split after saving')
    expect(refreshed.approved).toEqual([independentGrant])
    expect(await stored.allows(revoked)).toBe(false)
    await expect(mdx.revokeExternalResource({ ...split, grantId: obsolete!.id })).rejects.toThrow()
    await expect(
      mdx.compile({ ...split, generation: ++generation, source: `import '${independent}'\n` }),
    ).resolves.toEqual([])
    expect(contacts).toContain(independent)
  } finally {
    onChange = () => {}
    finishWrite.resolve()
    await Promise.allSettled([removal, ...refreshes])
    await mdx.releaseDiagnosticsLease(split)
    await mdx.releaseDiagnosticsLease(revoker)
  }
})
