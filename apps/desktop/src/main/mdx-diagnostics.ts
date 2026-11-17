import { randomBytes } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
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
  let closed = false
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
      if (closed || leases.size >= MAX_LEASES) fail('MDX diagnostics lease limit reached')
      const identity = options.context(input.context, input.remote)
      if (identity === null) throw new Error('MDX context unavailable')
      if (
        !options.authorize(identity, input.remote) ||
        !(await options.trusted(identity)) ||
        !options.authorize(identity, input.remote)
      )
        fail('MDX context unavailable')
      const path = vaultRelPath(input.path)
      if (
        !/\.mdx$/i.test(path) ||
        isSecretPath(path) ||
        isLocalOnlyPath(path) ||
        isAgentSurfacePath(path)
      )
        fail('MDX path unavailable')
      const root = await options.root(identity.remote)
      if (
        !options.authorize(identity, input.remote) ||
        !(await options.trusted(identity)) ||
        !options.authorize(identity, input.remote)
      )
        fail('MDX context changed')
      const canonicalRoot = await realpath(root)
      if (
        !options.authorize(identity, input.remote) ||
        !(await options.trusted(identity)) ||
        !options.authorize(identity, input.remote)
      )
        fail('MDX context changed')
      const canonical = await exactPath(canonicalRoot, path)
      if (
        !options.authorize(identity, input.remote) ||
        !(await options.trusted(identity)) ||
        !options.authorize(identity, input.remote) ||
        canonical === null ||
        canonical !== join(canonicalRoot, path)
      )
        throw new Error('MDX file unavailable')
      const info = await stat(canonical).catch(() => null)
      if (
        !options.authorize(identity, input.remote) ||
        !(await options.trusted(identity)) ||
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
          if (name === null || name.toString() === basename(canonical)) drop(lease)
        })
        lease.watcher.on('error', () => drop(lease))
      } catch {
        fail('MDX file watcher unavailable')
      }
      if (
        !options.authorize(identity, input.remote) ||
        !(await options.trusted(identity)) ||
        !options.authorize(identity, input.remote) ||
        leases.size >= MAX_LEASES
      ) {
        drop(lease)
        fail('MDX context changed')
      }
      leases.set(id, lease)
      return { lease: id }
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
      for (const lease of [...leases.values()]) drop(lease)
    },
    close() {
      closed = true
      for (const lease of [...leases.values()]) drop(lease)
    },
  }
}
