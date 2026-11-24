import { randomBytes } from 'node:crypto'
import type { MdxResourceOwner } from './mdx-resources'
import { inspectMdxDependencies } from './mdx-dependencies'
import type { MdxConsentStore } from './mdx-consent'
import { createMdxConsentCoordinator } from './mdx-consent-coordination'
import { canonicalGitHubRemote } from './mdx-trust'
import { fetchMdxExternalData, MdxExternalDataError } from './mdx-external-data'
import { realpathSync, statSync, watch, type FSWatcher } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { exactPath } from '@holi/shared/path-safety-node'
import {
  isAgentSurfacePath,
  isLocalOnlyPath,
  isSecretPath,
  vaultRelPath,
  type MdxDiagnostic,
  type MdxExternalResourceState,
} from '@holi/shared'

const MAX_LEASES = 4
const MAX_SOURCE_BYTES = 256 * 1024

type Identity = {
  accountGeneration: number
  accountId: string
  remote: string
  openRevision: number
  active: object
}
type Lease = {
  id: string
  identity: Identity
  root: string
  path: string
  fingerprint: string
  watcher: FSWatcher
  highGeneration: number
  controller: AbortController | null
  contextChanged: boolean
  closed: boolean
  resourceOwner: MdxResourceOwner
  consent: ReturnType<ReturnType<typeof createMdxConsentCoordinator>['attach']>
  graphCurrent: (() => boolean) | null
}

export interface MdxDiagnostics {
  acquire(input: { remote: string; path: string; context: string }): Promise<{ lease: string }>
  cancel(input: { lease: string; generation: number }): { ok: true }
  compile(input: { lease: string; generation: number; source: string }): Promise<MdxDiagnostic[]>
  release(input: { lease: string }): { ok: true }
  externalResources(input: { lease: string }): Promise<MdxExternalResourceState>
  approveExternalResource(input: { lease: string; requestId: string }): Promise<{ ok: true }>
  rejectExternalResource(input: { lease: string; requestId: string }): { ok: true }
  revokeExternalResource(input: { lease: string; grantId: string }): Promise<{ ok: true }>
  invalidate(): void
  invalidatePath(remote: string, path: string): void
  close(): void
}

export function createMdxDiagnostics(options: {
  authorize(identity: Identity, remote: string): boolean
  context(token: string, remote: string): Identity | null
  root(remote: string, identity: Identity): Promise<string>
  rootCurrent?(identity: Identity, root: string): boolean
  external?: {
    consent: MdxConsentStore
    fetch?: typeof fetchMdxExternalData
    changed?(remote: string): void
  }
  trusted(identity: Identity): Promise<boolean>
  createResourceOwner(isCurrent: () => Promise<boolean>): MdxResourceOwner
  retireResourceOwner(owner: MdxResourceOwner): void
  inspect(
    owner: MdxResourceOwner,
    source: string,
    signal: AbortSignal,
    format: 'mdx' | 'jsx' | 'js',
  ): Promise<import('./mdx-resources').MdxInspectResult>
}): MdxDiagnostics {
  const leases = new Map<string, Lease>()
  const coordinator = createMdxConsentCoordinator(options.external)
  let pending = 0
  let epoch = 0
  let closed = false
  const pendingAcquisitions = new Set<{
    remote: string
    path: string
    invalidated: boolean
  }>()
  const sameOrDescendant = (candidate: string, path: string) =>
    candidate === path || candidate.startsWith(`${path}/`)
  const fail = (message: string): never => {
    throw new Error(message)
  }
  const current = (lease: Lease) =>
    !closed &&
    !lease.closed &&
    leases.get(lease.id) === lease &&
    options.authorize(lease.identity, lease.identity.remote)
  const abortCompile = (lease: Lease) => {
    lease.controller?.abort()
    lease.controller = null
  }
  const retireSource = (lease: Lease) => {
    const offers = lease.consent.newSource()
    lease.graphCurrent = null
    abortCompile(lease)
    return offers
  }
  const drop = (lease: Lease) => {
    if (lease.closed) return
    lease.closed = true
    lease.consent.close()
    lease.graphCurrent = null
    abortCompile(lease)
    options.retireResourceOwner(lease.resourceOwner)
    lease.watcher?.close()
    leases.delete(lease.id)
  }
  const scopeFor = (root: string, { remote, accountId }: Identity) => ({ root, remote, accountId })
  const fingerprint = (info: {
    dev: number
    ino: number
    size: number
    mtimeMs: number
    ctimeMs: number
  }) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
  const fileCurrent = (lease: Lease) => {
    try {
      const path = join(lease.root, lease.path)
      if (
        realpathSync(lease.root) !== lease.root ||
        realpathSync(path) !== path ||
        options.rootCurrent?.(lease.identity, lease.root) === false
      )
        return false
      const info = statSync(path)
      return info.isFile() && fingerprint(info) === lease.fingerprint
    } catch {
      return false
    }
  }
  const consentFor = (id: string) => {
    const lease = leases.get(id)
    if (!lease) throw new Error('MDX lease unavailable')
    return lease.consent
  }
  const pathState = async (lease: Lease) => {
    if (!current(lease) || !(await options.trusted(lease.identity)) || !current(lease)) return null
    const root = await realpath(lease.root).catch(() => null)
    if (
      !current(lease) ||
      !(await options.trusted(lease.identity)) ||
      !current(lease) ||
      root === null ||
      root !== lease.root
    )
      return null
    const canonical = await exactPath(root, lease.path).catch(() => null)
    if (
      !current(lease) ||
      !(await options.trusted(lease.identity)) ||
      !current(lease) ||
      canonical === null ||
      canonical !== join(root, vaultRelPath(lease.path))
    )
      return null
    const info = await stat(canonical).catch(() => null)
    if (
      !current(lease) ||
      !(await options.trusted(lease.identity)) ||
      !current(lease) ||
      info === null ||
      !info.isFile()
    )
      return null
    return {
      canonical,
      fingerprint: fingerprint(info),
    }
  }
  return {
    async acquire(input) {
      const path = vaultRelPath(input.path)
      if (closed || leases.size + pending >= MAX_LEASES) fail('MDX diagnostics lease limit reached')
      const acquisitionEpoch = epoch
      const pendingAcquisition = {
        remote: canonicalGitHubRemote(input.remote),
        path: path.toLowerCase(),
        invalidated: false,
      }
      pending += 1
      pendingAcquisitions.add(pendingAcquisition)
      const valid = () => !closed && acquisitionEpoch === epoch && !pendingAcquisition.invalidated
      let unpublishedLease: Lease | null = null
      try {
        const identity = options.context(input.context, input.remote)
        if (identity === null) throw new Error('MDX context unavailable')
        if (!options.authorize(identity, input.remote)) fail('MDX context unavailable')
        const initiallyTrusted = await options.trusted(identity)
        if (!valid()) fail('MDX context changed')
        if (!initiallyTrusted || !options.authorize(identity, input.remote))
          fail('MDX context unavailable')
        if (
          !/\.mdx$/i.test(path) ||
          isSecretPath(path) ||
          isLocalOnlyPath(path) ||
          isAgentSurfacePath(path)
        )
          fail('MDX path unavailable')
        const root = await options.root(identity.remote, identity)
        if (!valid()) fail('MDX context changed')
        if (!options.authorize(identity, input.remote)) fail('MDX context changed')
        const trustedAfterRoot = await options.trusted(identity)
        if (!valid()) fail('MDX context changed')
        if (!trustedAfterRoot || !options.authorize(identity, input.remote))
          fail('MDX context changed')
        const canonicalRoot = await realpath(root)
        if (!valid()) fail('MDX context changed')
        if (!options.authorize(identity, input.remote)) fail('MDX context changed')
        const trustedAfterRealpath = await options.trusted(identity)
        if (!valid()) fail('MDX context changed')
        if (!trustedAfterRealpath || !options.authorize(identity, input.remote))
          fail('MDX context changed')
        const canonical = await exactPath(canonicalRoot, path)
        if (!valid()) fail('MDX context changed')
        if (!options.authorize(identity, input.remote)) fail('MDX context changed')
        const trustedAfterExactPath = await options.trusted(identity)
        if (!valid()) fail('MDX context changed')
        if (
          !trustedAfterExactPath ||
          !options.authorize(identity, input.remote) ||
          canonical === null ||
          canonical !== join(canonicalRoot, path)
        )
          throw new Error('MDX file unavailable')
        const info = await stat(canonical).catch(() => null)
        if (!valid()) fail('MDX context changed')
        if (!options.authorize(identity, input.remote)) fail('MDX context changed')
        const trustedAfterStat = await options.trusted(identity)
        if (!valid()) fail('MDX context changed')
        if (
          !trustedAfterStat ||
          !options.authorize(identity, input.remote) ||
          info === null ||
          !info.isFile()
        )
          throw new Error('MDX file unavailable')
        const id = randomBytes(32).toString('hex')
        const lease: Lease = {
          id,
          identity,
          root: canonicalRoot,
          path,
          fingerprint: fingerprint(info),
          watcher: null as unknown as FSWatcher,
          highGeneration: 0,
          controller: null,
          contextChanged: false,
          closed: false,
          resourceOwner: null as unknown as MdxResourceOwner,
          consent: coordinator.attach(scopeFor(canonicalRoot, identity), {
            current: () => current(lease) && fileCurrent(lease),
            recheck: async () => (await pathState(lease))?.fingerprint === lease.fingerprint,
            generation: () => lease.highGeneration,
            graphCurrent: () => lease.graphCurrent?.() === true,
            abortCompile: () => abortCompile(lease),
          }),
          graphCurrent: null,
        }
        try {
          lease.resourceOwner = options.createResourceOwner(async () => {
            if (!current(lease)) return false
            const state = await pathState(lease)
            return current(lease) && state !== null && state.fingerprint === lease.fingerprint
          })
        } catch (error) {
          lease.consent.close()
          throw error
        }
        unpublishedLease = lease
        try {
          lease.watcher = watch(dirname(canonical), { persistent: false }, (_event, name) => {
            if (name !== null && name.toString() !== basename(canonical)) return
            try {
              if (!fileCurrent(lease)) {
                lease.contextChanged = true
                drop(lease)
              }
            } catch {
              lease.contextChanged = true
              drop(lease)
            }
          })
          lease.watcher.on('error', () => drop(lease))
        } catch {
          lease.watcher?.close()
          fail('MDX file watcher unavailable')
        }
        if (!valid() || lease.closed) {
          drop(lease)
          fail('MDX context changed')
        }
        const isTrusted = await options.trusted(identity)
        if (
          !valid() ||
          lease.closed ||
          !options.authorize(identity, input.remote) ||
          !isTrusted ||
          !options.authorize(identity, input.remote) ||
          leases.size >= MAX_LEASES
        ) {
          drop(lease)
          fail('MDX context changed')
        }
        leases.set(id, lease)
        unpublishedLease = null
        return { lease: id }
      } catch (error) {
        if (unpublishedLease !== null) drop(unpublishedLease)
        throw error
      } finally {
        pendingAcquisitions.delete(pendingAcquisition)
        pending -= 1
      }
    },
    cancel(input) {
      const lease = leases.get(input.lease)
      if (lease === undefined) throw new Error('MDX lease unavailable')
      if (!Number.isSafeInteger(input.generation) || input.generation <= 0)
        fail('MDX lease unavailable')
      if (input.generation >= lease.highGeneration) {
        lease.highGeneration = input.generation
        retireSource(lease)
      }
      return { ok: true }
    },
    async compile(input) {
      const lease = leases.get(input.lease)
      if (lease === undefined) throw new Error('MDX lease unavailable')
      if (
        !Number.isSafeInteger(input.generation) ||
        input.generation <= 0 ||
        typeof input.source !== 'string' ||
        Buffer.byteLength(input.source, 'utf8') > MAX_SOURCE_BYTES
      )
        fail('MDX lease unavailable')
      if (input.generation < lease.highGeneration || !current(lease)) fail('MDX compile cancelled')
      lease.highGeneration = input.generation
      const offers = retireSource(lease)
      const controller = new AbortController()
      lease.controller = controller
      const running = () =>
        current(lease) &&
        lease.controller === controller &&
        lease.highGeneration === input.generation &&
        !controller.signal.aborted
      const snapshot: { current: (() => boolean) | null } = { current: null }
      const external = options.external
      const scope = scopeFor(lease.root, lease.identity)
      const state = await pathState(lease)
      if (lease.contextChanged) fail('MDX context changed')
      if (
        lease.controller !== controller ||
        input.generation !== lease.highGeneration ||
        controller.signal.aborted
      )
        fail('MDX compile superseded')
      if (!state || state.fingerprint !== lease.fingerprint || !current(lease)) {
        drop(lease)
        fail('MDX context changed')
      }
      try {
        if (!current(lease) || lease.controller !== controller || controller.signal.aborted)
          fail('MDX compile superseded')
        const diagnostics = await inspectMdxDependencies({
          root: lease.root,
          path: lease.path,
          source: input.source,
          signal: controller.signal,
          owner: lease.resourceOwner,
          assertCurrent: async () => {
            if (!running()) fail('MDX compile superseded')
            if (!(await options.trusted(lease.identity)) || !running()) fail('MDX context changed')
          },
          external: external && {
            async fetch(url, signal, localTreeCurrent, discoveryOrigins) {
              try {
                return await (external.fetch ?? fetchMdxExternalData)({
                  url,
                  signal,
                  async assertAccess(origin, accessSignal) {
                    const assertOwned = () => {
                      if (
                        !running() ||
                        accessSignal.aborted ||
                        !fileCurrent(lease) ||
                        !localTreeCurrent()
                      )
                        throw new MdxExternalDataError('access-changed')
                    }
                    assertOwned()
                    if (!(await options.trusted(lease.identity)))
                      throw new MdxExternalDataError('access-changed')
                    assertOwned()
                    const allowed = await external.consent.allows({ ...scope, origin })
                    assertOwned()
                    if (allowed) discoveryOrigins.add(origin)
                    return allowed
                  },
                })
              } catch (error) {
                if (
                  running() &&
                  error instanceof MdxExternalDataError &&
                  error.code === 'consent-needed' &&
                  error.origin
                ) {
                  offers.discover(error.origin, discoveryOrigins)
                }
                throw error
              }
            },
            retainSnapshot(localTreeCurrent) {
              snapshot.current = localTreeCurrent
            },
          },
          inspect: (owner, source, signal, format) =>
            options.inspect(owner, source, signal, format),
        })
        if (
          lease.controller !== controller ||
          input.generation !== lease.highGeneration ||
          controller.signal.aborted
        )
          fail('MDX compile superseded')
        const after = await pathState(lease)
        if (
          lease.controller !== controller ||
          input.generation !== lease.highGeneration ||
          controller.signal.aborted
        )
          fail('MDX compile superseded')
        if (!after || after.fingerprint !== lease.fingerprint || !current(lease)) {
          drop(lease)
          fail('MDX context changed')
        }
        if (snapshot.current && !snapshot.current()) fail('MDX context changed')
        lease.graphCurrent = snapshot.current
        offers.publish()
        return diagnostics
      } finally {
        if (lease.controller === controller) lease.controller = null
      }
    },
    release(input) {
      const lease = leases.get(input.lease)
      if (lease) drop(lease)
      return { ok: true }
    },
    async externalResources(input) {
      return consentFor(input.lease).list()
    },
    async approveExternalResource(input) {
      return consentFor(input.lease).approve(input.requestId)
    },
    rejectExternalResource(input) {
      return consentFor(input.lease).reject(input.requestId)
    },
    async revokeExternalResource(input) {
      return consentFor(input.lease).revoke(input.grantId)
    },
    invalidate() {
      epoch += 1
      for (const lease of [...leases.values()]) drop(lease)
    },
    invalidatePath(remote, path) {
      const normalized = vaultRelPath(path).toLowerCase()
      const canonicalRemote = canonicalGitHubRemote(remote)
      for (const acquisition of pendingAcquisitions) {
        if (
          acquisition.remote === canonicalRemote &&
          sameOrDescendant(acquisition.path, normalized)
        )
          acquisition.invalidated = true
      }
      for (const lease of [...leases.values()]) {
        if (
          lease.identity.remote === canonicalRemote &&
          sameOrDescendant(lease.path.toLowerCase(), normalized)
        )
          drop(lease)
      }
    },
    close() {
      epoch += 1
      closed = true
      for (const lease of [...leases.values()]) drop(lease)
      coordinator.close()
    },
  }
}
