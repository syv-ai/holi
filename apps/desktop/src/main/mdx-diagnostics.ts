import { randomBytes } from 'node:crypto'
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
  closed: boolean
}

export interface MdxDiagnostics {
  acquire(input: { remote: string; path: string; context: string }): Promise<{ lease: string }>
  cancel(input: { lease: string; generation: number }): { ok: true }
  compile(input: { lease: string; generation: number; source: string }): Promise<MdxDiagnostic[]>
  release(input: { lease: string }): { ok: true }
  invalidate(): void
  invalidatePath(remote: string, path: string): void
  close(): void
}

export function createMdxDiagnostics(options: {
  authorize(identity: Identity, remote: string): boolean
  context(token: string, remote: string): Identity | null
  root(remote: string): Promise<string>
  trusted(identity: Identity): Promise<boolean>
  compile(source: string, signal: AbortSignal): Promise<MdxDiagnostic[]>
}): MdxDiagnostics {
  const leases = new Map<string, Lease>()
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
  const drop = (lease: Lease) => {
    if (lease.closed) return
    lease.closed = true
    lease.controller?.abort()
    lease.controller = null
    lease.watcher.close()
    leases.delete(lease.id)
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
      fingerprint: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
    }
  }
  return {
    async acquire(input) {
      const path = vaultRelPath(input.path)
      if (closed || leases.size + pending >= MAX_LEASES) fail('MDX diagnostics lease limit reached')
      pending += 1
      const acquisitionEpoch = epoch
      const pendingAcquisition = {
        remote: input.remote.toLowerCase(),
        path: path.toLowerCase(),
        invalidated: false,
      }
      pendingAcquisitions.add(pendingAcquisition)
      const valid = () => !closed && acquisitionEpoch === epoch && !pendingAcquisition.invalidated
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
        const root = await options.root(identity.remote)
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
        const fingerprint = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
        const id = randomBytes(32).toString('hex')
        const lease = {
          id,
          identity,
          root: canonicalRoot,
          path,
          fingerprint,
          watcher: null as unknown as FSWatcher,
          highGeneration: 0,
          controller: null,
          closed: false,
        }
        try {
          lease.watcher = watch(dirname(canonical), { persistent: false }, (_event, name) => {
            if (name !== null && name.toString() !== basename(canonical)) return
            try {
              const currentRoot = realpathSync(lease.root)
              const currentPath = realpathSync(canonical)
              const currentInfo = statSync(currentPath)
              const currentFingerprint = `${currentInfo.dev}:${currentInfo.ino}:${currentInfo.size}:${currentInfo.mtimeMs}:${currentInfo.ctimeMs}`
              if (
                currentRoot !== lease.root ||
                currentPath !== join(currentRoot, vaultRelPath(lease.path)) ||
                !currentInfo.isFile() ||
                currentFingerprint !== lease.fingerprint
              )
                drop(lease)
            } catch {
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
        return { lease: id }
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
      lease.highGeneration = Math.max(lease.highGeneration, input.generation)
      lease.controller?.abort()
      lease.controller = null
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
      lease.controller?.abort()
      const controller = new AbortController()
      lease.controller = controller
      const state = await pathState(lease)
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
        const result = await options.compile(input.source, controller.signal)
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
        return result
      } finally {
        if (lease.controller === controller) lease.controller = null
      }
    },
    release(input) {
      const lease = leases.get(input.lease)
      if (lease) drop(lease)
      return { ok: true }
    },
    invalidate() {
      epoch += 1
      for (const lease of [...leases.values()]) drop(lease)
    },
    invalidatePath(remote, path) {
      const normalized = vaultRelPath(path).toLowerCase()
      const canonicalRemote = remote.toLowerCase()
      for (const acquisition of pendingAcquisitions) {
        if (
          acquisition.remote === canonicalRemote &&
          sameOrDescendant(acquisition.path, normalized)
        )
          acquisition.invalidated = true
      }
      for (const lease of [...leases.values()]) {
        if (
          lease.identity.remote.toLowerCase() === remote.toLowerCase() &&
          sameOrDescendant(lease.path.toLowerCase(), normalized)
        )
          drop(lease)
      }
    },
    close() {
      epoch += 1
      closed = true
      for (const lease of [...leases.values()]) drop(lease)
    },
  }
}
