import { EventEmitter } from 'node:events'
import { mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow, WebContents } from 'electron'
import { expect, it, vi } from 'vitest'
import { requestFlush } from '../src/main/flush'
import { createMdxConsentStore } from '../src/main/mdx-consent'
import { guardNavigation } from '../src/main/window-guard'
import { within } from './fixtures/fixture-deadline'
import { auth, REMOTE, gate, rig, resourceRig } from './fixtures/mdx-router'

const entry = 'https://one.example/entry.js'
const externalSource = `import '${entry}?opaque=value'\n`

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
  const reading = mdx.externalResources(owner)
  await mdx.cancelCompile({ ...owner, generation: 2 })
  expect(await reading).toMatchObject({ approved: [], pending: [] })
  await staleApproval
  await pending(2)
  await expect(mdx.approveExternalResource(edited)).rejects.toThrow()
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

it('allows Retry after prevention or abort but retires leases when a new document or error page commits', async () => {
  const contents = Object.assign(new EventEmitter(), { setWindowOpenHandler: () => {} })
  const document = contents as unknown as WebContents
  const appUrl = 'file:///holi/index.html'
  guardNavigation({ webContents: document } as BrowserWindow, appUrl, () => {}, new Set())
  const { caller, root } = await rig({ document, signedIn: auth(42, 'alice') })
  const mdx = caller.mdxTrust
  const start = (url: string) =>
    contents.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false })
  const commit = () => contents.emit('did-navigate', {}, appUrl, -1, '')
  start(appUrl)
  await expect(mdx.status({ remote: REMOTE })).rejects.toThrow()
  commit()
  await writeFile(join(root, 'page.mdx'), '# source')
  const { context } = await mdx.status({ remote: REMOTE })
  await mdx.approve({ remote: REMOTE, context: context! })
  const acquire = (context: string) =>
    mdx.acquireDiagnosticsLease({ remote: REMOTE, path: 'page.mdx', context })
  const trusted = (await mdx.status({ remote: REMOTE })).context!
  const compile = (owner: { lease: string }) =>
    mdx.compile({ ...owner, generation: 1, source: '# source' })
  const initial = await acquire(trusted)

  const away = 'file:///dropped.txt'
  start(away)
  let prevented = false
  contents.emit('will-navigate', { url: away, preventDefault: () => (prevented = true) }, away)
  expect(prevented).toBe(true)
  // Electron does not emit did-navigate for the cancelled attempt.
  await expect(compile(initial)).rejects.toThrow()
  const retried = await acquire(trusted)
  await expect(compile(retried)).resolves.toHaveLength(1)

  // A programmatic reload has no cancellable will-navigate. Model a retry from
  // the still-committed document before Chromium commits the replacement.
  start(appUrl)
  await expect(compile(retried)).rejects.toThrow()
  const provisional = await acquire(trusted)
  commit()
  await expect(compile(provisional)).rejects.toThrow()
  await expect(acquire(trusted)).rejects.toThrow()
  const replacementContext = (await mdx.status({ remote: REMOTE })).context!
  const replacement = await acquire(replacementContext)
  await expect(compile(replacement)).resolves.toHaveLength(1)

  const missing = 'file:///holi/missing.html'
  start(missing)
  await expect(compile(replacement)).rejects.toThrow()
  // A loadURL rejected with ERR_ABORTED without commit only stops loading.
  contents.emit('did-stop-loading')
  const stillCommitted = await acquire(replacementContext)
  await expect(compile(stillCommitted)).resolves.toHaveLength(1)

  start(missing)
  const beforeErrorCommit = await acquire(replacementContext)
  contents.emit('did-fail-provisional-load', {}, -6, 'ERR_FILE_NOT_FOUND', missing, false, 1, 2)
  await expect(compile(beforeErrorCommit)).resolves.toHaveLength(1)
  contents.emit('did-fail-provisional-load', {}, -6, 'ERR_FILE_NOT_FOUND', missing, true, 1, 1)
  await expect(compile(beforeErrorCommit)).rejects.toThrow()
  await expect(acquire(replacementContext)).rejects.toThrow()
  await expect(mdx.status({ remote: REMOTE })).rejects.toThrow()

  start(appUrl)
  commit()
  const recovered = await acquire((await mdx.status({ remote: REMOTE })).context!)
  await expect(compile(recovered)).resolves.toHaveLength(1)
  await mdx.releaseDiagnosticsLease(recovered)
})

it('drains a revocation accepted before document retirement and denies new admissions on shutdown', async () => {
  let onChange = () => {}
  const { mdx, acquire, root, consentFile, shutdown } = await resourceRig(false, {
    onResourceChange: () => onChange(),
  })
  const owner = await acquire()
  await mdx.compile({ ...owner, generation: 1, source: externalSource })
  const requestId = (await mdx.externalResources(owner)).pending[0]!.id
  await mdx.approveExternalResource({ ...owner, requestId })
  const grant = (await mdx.externalResources(owner)).approved[0]!
  const scope = {
    root: await realpath(root),
    remote: REMOTE,
    accountId: '42',
    origin: grant.origin,
  }
  const accepted = gate<boolean>()
  // Close admission synchronously on the revocation's invalidation push, before its write can start.
  onChange = () =>
    accepted.resolve(
      shutdown(async () => {
        expect(await createMdxConsentStore(consentFile).allows(scope)).toBe(false)
        return true
      }),
    )
  const revoke = { ...owner, grantId: grant.id }
  const revoked = expect(mdx.revokeExternalResource(revoke)).resolves.toEqual({ ok: true })
  await expect(
    within(accepted.promise, 3_000, 'drain accepted revocation on shutdown'),
  ).resolves.toBe(true)
  await expect(mdx.status({ remote: REMOTE })).rejects.toThrow()
  await expect(mdx.revokeExternalResource(revoke)).rejects.toThrow()
  await revoked
  await mdx.releaseDiagnosticsLease(owner)
})

it('retires drained grant IDs in every split when a failed buffer flush vetoes quit', async () => {
  const { mdx, acquire, root, consentFile, shutdown, contacts, routes } = await resourceRig()
  const owner = await acquire()
  const other = await acquire()
  const observing = await acquire()
  const url = `${entry}?opaque=value`
  routes.set(url, { text: 'export const value = true' })
  const scope = {
    root: await realpath(root),
    remote: REMOTE,
    accountId: '42',
    origin: new URL(entry).origin,
  }
  const stored = () => createMdxConsentStore(consentFile).allows(scope)
  const approve = async (split: { lease: string }, generation: number) => {
    await mdx.compile({ ...split, generation, source: externalSource })
    const { pending } = await mdx.externalResources(split)
    await mdx.approveExternalResource({ ...split, requestId: pending[0]!.id })
  }
  try {
    await approve(owner, 1)
    const grant = (await mdx.externalResources(owner)).approved[0]!
    const observed = (await mdx.externalResources(observing)).approved[0]!
    const revoke = { ...owner, grantId: grant.id }
    const backup = `${consentFile}.backup`
    await rename(consentFile, backup)
    await mkdir(consentFile)
    await expect(mdx.revokeExternalResource(revoke)).rejects.toThrow()
    await expect(mdx.externalResources(owner)).resolves.toMatchObject({
      approved: [{ ...grant, revocationPending: true }],
    })
    await rm(consentFile, { recursive: true })
    await rename(backup, consentFile)
    expect(await stored()).toBe(true)

    const renderer = new EventEmitter()
    await expect(
      shutdown(async () => {
        expect(await stored()).toBe(false)
        await expect(mdx.status({ remote: REMOTE })).rejects.toThrow()
        const result = await requestFlush({
          send: (id) => renderer.emit('done', id, 'write failed'),
          onDone(done) {
            renderer.on('done', done)
            return () => renderer.off('done', done)
          },
        })
        return result === 'flushed'
      }),
    ).resolves.toBe(false)

    await approve(other, 1)
    // Don't refresh either split before trying its old ID: the views can still
    // hold IDs issued before the quit attempt.
    await expect(mdx.revokeExternalResource(revoke)).rejects.toThrow()
    await expect(
      mdx.revokeExternalResource({ ...observing, grantId: observed.id }),
    ).rejects.toThrow()
    expect(await stored()).toBe(true)
    await expect(mdx.compile({ ...owner, generation: 2, source: externalSource })).resolves.toEqual(
      [],
    )
    expect(contacts).toContain(url)

    const { approved } = await mdx.externalResources(owner)
    expect(approved).toMatchObject([{ origin: scope.origin }])
    expect(approved[0]!.id).not.toBe(revoke.grantId)
    await expect(
      mdx.revokeExternalResource({ ...owner, grantId: approved[0]!.id }),
    ).resolves.toEqual({ ok: true })
    expect(await stored()).toBe(false)
  } finally {
    await mdx.releaseDiagnosticsLease(owner)
    await mdx.releaseDiagnosticsLease(other)
    await mdx.releaseDiagnosticsLease(observing)
  }
})

it('retries an unsaved revocation on quit even after sign-out and vault removal', async () => {
  const { caller, mdx, acquire, root, consentFile, shutdown } = await resourceRig()
  const owner = await acquire()
  try {
    await mdx.compile({ ...owner, generation: 1, source: externalSource })
    const requestId = (await mdx.externalResources(owner)).pending[0]!.id
    await mdx.approveExternalResource({ ...owner, requestId })
    const grant = (await mdx.externalResources(owner)).approved[0]!
    const backup = `${consentFile}.backup`
    await rename(consentFile, backup)
    await mkdir(consentFile)
    const revoke = { ...owner, grantId: grant.id }
    await expect(mdx.revokeExternalResource(revoke)).rejects.toThrow()

    const scope = {
      root: await realpath(root),
      remote: REMOTE,
      accountId: '42',
      origin: grant.origin,
    }
    const stored = () => createMdxConsentStore(consentFile).allows(scope)
    const quit = vi.fn(async () => {
      expect(await stored()).toBe(false)
      return true
    })
    const reportBlocked = vi.fn(async () => {})
    await expect(shutdown(quit, reportBlocked)).resolves.toBe(false)
    expect(reportBlocked).toHaveBeenCalledOnce()
    expect(quit).not.toHaveBeenCalled()
    // The failed quit restored admission, but the grant stayed blocked.
    await expect(mdx.externalResources(owner)).resolves.toMatchObject({
      approved: [{ ...grant, revocationPending: true }],
    })

    await caller.auth.signOut()
    await caller.vaults.remove({ remote: REMOTE })
    await expect(mdx.revokeExternalResource(revoke)).rejects.toThrow()
    await rm(consentFile, { recursive: true })
    await rename(backup, consentFile)
    expect(await stored()).toBe(true)

    await expect(shutdown(quit, reportBlocked)).resolves.toBe(true)
    expect(quit).toHaveBeenCalledOnce()
    expect(reportBlocked).toHaveBeenCalledOnce()
  } finally {
    await mdx.releaseDiagnosticsLease(owner)
  }
})
