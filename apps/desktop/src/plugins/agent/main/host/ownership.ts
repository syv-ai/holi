import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { inspectPosixOwnership } from '../../../../main/plugin-api'
import type { VaultRef } from '../provider'

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const entryName = new RegExp(`^(${uuid})(\\.retired)?$`)
const label = /^[a-zA-Z0-9_-]{1,128}$/
const missing = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
const dirFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const limit = 2048

type Consumer = 'fenced' | 'pty' | 'pi' | 'jobs'

function syncDir(path: string): void {
  const fd = openSync(path, dirFlags)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function privateDir(path: string, create = false): void {
  if (create) {
    try {
      mkdirSync(path, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.uid !== process.getuid!() || stat.mode & 0o077)
    throw new Error(`Agent ownership directory is not private: ${path}`)
}

function publish(dir: string, name: string, data: string): void {
  const path = join(dir, name)
  const temp = `${path}.tmp`
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    writeFileSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, path)
  syncDir(dir)
}

function read(dir: string, name: string): string | undefined {
  let fd: number
  try {
    fd = openSync(join(dir, name), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  } catch (error) {
    if (missing(error)) return
    throw error
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || stat.mode & 0o077)
      throw new Error(`Invalid agent ownership file: ${name}`)
    const bytes = Buffer.alloc(limit + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (!count) break
      length += count
    }
    if (length > limit) throw new Error(`Oversized agent ownership file: ${name}`)
    return bytes.toString('utf8', 0, length)
  } finally {
    closeSync(fd)
  }
}

export interface LaunchOwnership {
  /** Fresh path for native core, not pre-created. Absent for an explicit fake. */
  readonly ownershipRecordPath: string | undefined
  /** Positive proof of no native invocation, or verified non-admission and joined cleanup. */
  nonLaunch(): void
  /** Preserve the first failure, even if native proof eventually succeeds. */
  fail(error: unknown): void
  /** Only after explicit physical proof AND caller finalization (including scratch deletion). */
  retire(): void
}

export interface FencedOwnership extends LaunchOwnership {
  /** Finalization has started, but output, copy-back or provider release may be pending. */
  beginCallerFinalization(): void
  /** After physical proof and successful caller work, before deleting its source. */
  settleCaller(): void
}

interface RecoveryScratch {
  root: string
  /** Map each top-level scratch entry to its durable consumer ID. No match means retain. */
  consumerId(entry: string): string | undefined
}

/** Holi's single Main and PluginHost generation own admission. Open/recover only
 * after the previous controller for this canonical Vault cannot launch again;
 * recovery does not acquire authority from a PID or inspect any active scope. */
export function activationOwnership(userData: string, vault: VaultRef, signal: AbortSignal) {
  if (process.platform === 'win32') return
  const data = realpathSync(userData)
  const key = createHash('sha256')
    .update(JSON.stringify([vault.remote.toLowerCase(), realpathSync(vault.root)]))
    .digest('hex')
  const base = join(data, 'agent-ownership')
  const scope = join(base, key)
  const generation = randomUUID()
  const used = new Set<Consumer>()
  const ready = new Set<Consumer>()
  privateDir(base, true)
  syncDir(data)
  privateDir(scope, true)
  syncDir(base)

  function retire(parent: string, name: string): void {
    const path = join(parent, `${name}.retired`)
    renameSync(join(parent, name), path)
    syncDir(parent)
    rmSync(path, { recursive: true, force: true })
  }

  // Fenced caller receipts are deliberately not offered to other consumers.
  function allocate(kind: 'fenced', id: string, proof?: 'native' | 'explicit'): FencedOwnership
  function allocate(kind: Consumer, id: string, proof?: 'native' | 'explicit'): LaunchOwnership
  function allocate(
    kind: Consumer,
    id: string,
    proof: 'native' | 'explicit' = 'native',
  ): FencedOwnership {
    signal.throwIfAborted()
    if (!ready.has(kind)) throw new Error(`Recover ${kind} ownership before allocating.`)
    if (!label.test(id)) throw new Error('Invalid agent ownership consumer ID.')
    used.add(kind)
    const name = randomUUID()
    const parent = join(scope, kind)
    const path = join(parent, name)
    mkdirSync(path, { mode: 0o700 })
    const native = join(path, 'native')
    if (proof === 'native') mkdirSync(native, { mode: 0o700 })
    const header = `HOLI-AGENT-1 ${name}\n`
    publish(path, 'link', `${header}${generation} ${proof} ${id}\n`)
    syncDir(parent)
    let nonLaunch = false
    let failed = false
    let done = false
    let finalizing = false
    let callerSettled = false
    return {
      ownershipRecordPath: proof === 'native' ? join(native, name) : undefined,
      nonLaunch() {
        if (nonLaunch || failed || done) return
        publish(path, 'nonlaunch', header + 'NONLAUNCH\n')
        nonLaunch = true
      },
      fail(error) {
        if (failed || done) return
        failed = true
        publish(path, 'failed', header + Buffer.from(String(error)).subarray(0, 1500).toString())
      },
      beginCallerFinalization() {
        if (kind !== 'fenced' || done) throw new Error('Cannot begin fenced finalization.')
        if (finalizing || failed) return
        publish(path, 'caller-finalizing', header + 'FINALIZING\n')
        finalizing = true
      },
      settleCaller() {
        if (!finalizing || failed || done) throw new Error('Cannot settle fenced finalization.')
        if (callerSettled) return
        publish(path, 'caller-settled', header + 'SETTLED\n')
        callerSettled = true
      },
      retire() {
        if (done) return
        if (failed) throw new Error('Cannot retire failed agent ownership.')
        if (kind === 'fenced' && !callerSettled && !(nonLaunch && !finalizing))
          throw new Error('Cannot retire fenced ownership without caller settlement.')
        publish(path, 'settled', header + 'SETTLED\n')
        retire(parent, name)
        done = true
      },
    }
  }

  return {
    /** Inspect every old link and, optionally, every entry of one scratch root
     * before deleting anything. A failed inspection never sweeps partial state. */
    recover(kind: Consumer, scratch?: RecoveryScratch): void {
      signal.throwIfAborted()
      if (used.has(kind)) throw new Error('Cannot recover a live agent ownership scope.')
      const parent = join(scope, kind)
      privateDir(parent, true)
      syncDir(scope)
      const links = new Set<string>()
      const confirmed: string[] = []
      const retired: string[] = []
      const retain = (entry: string, reason: string): never => {
        throw new Error(`Retaining ${vault.remote} ${kind} ownership (${entry}): ${reason}`)
      }
      for (const name of readdirSync(parent)) {
        const match = entryName.exec(name)
        if (!match) retain(name, 'Unknown ownership entry.')
        const path = join(parent, name)
        privateDir(path)
        if (match?.[2]) {
          retired.push(path)
          continue
        }
        const header = `HOLI-AGENT-1 ${name}\n`
        const link = read(path, 'link')
        const matchLink = link?.startsWith(header)
          ? new RegExp(`^(${uuid}) (native|explicit) ([a-zA-Z0-9_-]{1,128})\\n$`).exec(
              link.slice(header.length),
            )
          : null
        if (!matchLink) throw new Error(`Retaining ${vault.remote} ${kind}: invalid link ${path}.`)
        const [, previous, proof, id] = matchLink
        if (previous === generation) retain(name, 'Current activation.')
        for (const file of readdirSync(path)) {
          if (
            !['link', 'settled', 'nonlaunch', 'failed', 'native'].includes(file) &&
            !(kind === 'fenced' && ['caller-finalizing', 'caller-settled'].includes(file))
          )
            retain(name, 'Unknown or partial ownership evidence.')
        }
        const failed = read(path, 'failed')
        if (failed !== undefined) retain(name, `Caller failure: ${failed.slice(header.length)}`)
        const settled = read(path, 'settled')
        const preflight = read(path, 'nonlaunch')
        if (settled !== undefined && settled !== header + 'SETTLED\n')
          retain(name, 'Invalid caller settlement.')
        if (preflight !== undefined && preflight !== header + 'NONLAUNCH\n')
          retain(name, 'Invalid non-launch evidence.')
        const finalizing = kind === 'fenced' ? read(path, 'caller-finalizing') : undefined
        const caller = kind === 'fenced' ? read(path, 'caller-settled') : undefined
        if (finalizing !== undefined && finalizing !== header + 'FINALIZING\n')
          retain(name, 'Invalid fenced finalization phase.')
        if (caller !== undefined && (caller !== header + 'SETTLED\n' || finalizing === undefined))
          retain(name, 'Invalid fenced caller settlement.')
        if (finalizing !== undefined && caller === undefined)
          retain(name, 'Fenced caller finalization is pending.')
        if (settled === undefined && preflight === undefined) {
          if (proof === 'native') {
            const result = inspectPosixOwnership(join(path, 'native', name))
            if (result.state === 'retain') retain(name, result.reason)
            // Native SETTLED proves physical absence only. The distinct cold
            // kernel-absence path still works if caller finalization never began.
            if (result.state === 'confirmed' && result.proof === 'settled') {
              if (kind === 'pi') retain(name, 'Missing Pi output and caller settlement.')
              if (kind === 'fenced' && caller === undefined)
                retain(name, 'Missing fenced output and caller settlement.')
            }
          } else retain(name, 'No explicit physical settlement.')
        }
        links.add(id!)
        confirmed.push(name)
      }
      if (scratch) {
        const top = scratchEntries(scratch.root)
        for (const entry of top) {
          const id = scratch.consumerId(entry)
          if (id === undefined || !links.has(id)) retain(entry, 'Missing scratch ownership link.')
        }
        rmSync(scratch.root, { recursive: true, force: true })
        syncDir(join(scratch.root, '..'))
      }
      for (const name of confirmed) retire(parent, name)
      for (const path of retired) rmSync(path, { recursive: true, force: true })
      ready.add(kind)
    },

    /** Publish a unique consumer link before starting work. The default is a
     * native journal; explicit adapters can only settle via their own promise. */
    allocate,
  }
}

export type ActivationOwnership = NonNullable<ReturnType<typeof activationOwnership>>

export function scratchEntries(path: string): string[] {
  try {
    if (!lstatSync(path).isDirectory()) throw new Error(`Not an agent scratch directory: ${path}`)
    return readdirSync(path)
  } catch (error) {
    if (!missing(error)) throw error
    return []
  }
}
