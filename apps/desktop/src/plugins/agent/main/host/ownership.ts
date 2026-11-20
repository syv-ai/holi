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
import { dirname, join } from 'node:path'
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

export interface CallerOwnership extends LaunchOwnership {
  /** Finalization has started, but output, copy-back or provider release may be pending. */
  beginCallerFinalization(): void
  /** After physical proof and successful caller work, before deleting its source. */
  settleCaller(): void
}

export type FencedOwnership = CallerOwnership

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

  function recordFailure(path: string, header: string, link: string, error: unknown): void {
    // Recursive removal can fail after unlinking the link (or the directory).
    // Restore the consumer identity on this side of the rename, never on the
    // immutable path formerly handed to the native writer.
    privateDir(path, true)
    publish(path, 'failed', header + Buffer.from(String(error)).subarray(0, 1500).toString())
    if (read(path, 'link') === undefined) publish(path, 'link', link)
    syncDir(dirname(path))
  }

  function removeRetired(path: string, parent: string, fail: (error: unknown) => void): void {
    try {
      syncDir(parent)
      rmSync(path, { recursive: true, force: true })
    } catch (error) {
      try {
        fail(error)
      } catch (recordError) {
        console.error('[agent] Could not persist retirement failure:', recordError)
      }
      throw error
    }
  }

  // Only these consumers publish a separate phase for caller settlement.
  function allocate(
    kind: 'fenced' | 'pi',
    id: string,
    proof?: 'native' | 'explicit',
  ): CallerOwnership
  function allocate(kind: Consumer, id: string, proof?: 'native' | 'explicit'): LaunchOwnership
  function allocate(
    kind: Consumer,
    id: string,
    proof: 'native' | 'explicit' = 'native',
  ): CallerOwnership {
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
    const link = `${header}${generation} ${proof} ${id}\n`
    publish(path, 'link', link)
    syncDir(parent)
    let nonLaunch = false
    let failure: { cause: unknown } | undefined
    let done = false
    let finalizing = false
    let callerSettled = false
    let failurePath = path
    const phased = kind === 'fenced' || kind === 'pi'
    const fail = (error: unknown) => {
      if (failure || done) return
      failure = { cause: error }
      recordFailure(failurePath, header, link, error)
    }
    return {
      ownershipRecordPath: proof === 'native' ? join(native, name) : undefined,
      nonLaunch() {
        if (nonLaunch || failure || done) return
        publish(path, 'nonlaunch', header + 'NONLAUNCH\n')
        nonLaunch = true
      },
      fail,
      beginCallerFinalization() {
        if (!phased || done) throw new Error(`Cannot begin ${kind} finalization.`)
        if (finalizing || failure) return
        publish(path, 'caller-finalizing', header + 'FINALIZING\n')
        finalizing = true
      },
      settleCaller() {
        if (!finalizing || failure || done) throw new Error(`Cannot settle ${kind} finalization.`)
        if (callerSettled) return
        publish(path, 'caller-settled', header + 'SETTLED\n')
        callerSettled = true
      },
      retire() {
        if (done) return
        if (failure) throw failure.cause
        if (phased && !callerSettled && !(nonLaunch && !finalizing))
          throw new Error(`Cannot retire ${kind} ownership without caller settlement.`)
        publish(path, 'settled', header + 'SETTLED\n')
        const retired = `${path}.retired`
        renameSync(path, retired)
        failurePath = retired
        removeRetired(retired, parent, fail)
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
      const confirmed: Array<() => void> = []
      const retain = (entry: string, reason: string): never => {
        throw new Error(`Retaining ${vault.remote} ${kind} ownership (${entry}): ${reason}`)
      }
      for (const name of readdirSync(parent)) {
        const match = entryName.exec(name)
        if (!match)
          throw new Error(`Retaining ${vault.remote} ${kind}: unknown ownership entry ${name}.`)
        const [, nonce, suffix] = match
        const path = join(parent, name)
        privateDir(path)
        const header = `HOLI-AGENT-1 ${nonce}\n`
        // A renamed path is not proof. In particular, an error during parent
        // sync or partial removal can leave a failure beside a positive receipt.
        const failed = read(path, 'failed')
        if (failed !== undefined) {
          if (!failed.startsWith(header)) retain(name, 'Invalid caller failure evidence.')
          retain(name, `Caller failure: ${failed.slice(header.length)}`)
        }
        const link = read(path, 'link')
        const matchLink = link?.startsWith(header)
          ? new RegExp(`^(${uuid}) (native|explicit) ([a-zA-Z0-9_-]{1,128})\\n$`).exec(
              link.slice(header.length),
            )
          : null
        if (!matchLink) throw new Error(`Retaining ${vault.remote} ${kind}: invalid link ${path}.`)
        const [, previous, proof, id] = matchLink
        if (previous === generation) retain(name, 'Current activation.')
        const phased = kind === 'fenced' || kind === 'pi'
        const consumer = kind === 'pi' ? 'Pi' : kind === 'fenced' ? 'Fenced' : kind
        for (const file of readdirSync(path)) {
          if (
            !['link', 'settled', 'nonlaunch', 'failed', 'native'].includes(file) &&
            !(phased && ['caller-finalizing', 'caller-settled'].includes(file))
          )
            retain(name, 'Unknown or partial ownership evidence.')
        }
        const settled = read(path, 'settled')
        const preflight = read(path, 'nonlaunch')
        if (settled !== undefined && settled !== header + 'SETTLED\n')
          retain(name, 'Invalid caller settlement.')
        if (preflight !== undefined && preflight !== header + 'NONLAUNCH\n')
          retain(name, 'Invalid non-launch evidence.')
        const finalizing = phased ? read(path, 'caller-finalizing') : undefined
        const caller = phased ? read(path, 'caller-settled') : undefined
        if (finalizing !== undefined && finalizing !== header + 'FINALIZING\n')
          retain(name, `Invalid ${consumer} finalization phase.`)
        if (caller !== undefined && (caller !== header + 'SETTLED\n' || finalizing === undefined))
          retain(name, `Invalid ${consumer} caller settlement.`)
        if (finalizing !== undefined && caller === undefined)
          retain(name, `${consumer} caller finalization is pending.`)
        const native = join(path, 'native')
        if (suffix) {
          if (settled === undefined || (phased && caller === undefined && preflight === undefined))
            retain(name, 'Missing retired caller settlement.')
          if (proof === 'native') {
            privateDir(native)
            const entries = readdirSync(native)
            if (entries.some((entry) => entry !== nonce))
              retain(name, 'Unexpected retired native evidence.')
            const journal = join(native, nonce!)
            if (entries.length !== 0) {
              privateDir(journal)
              if (readdirSync(journal).some((file) => !['journal', 'settled'].includes(file)))
                retain(name, 'Unknown or partial retired native evidence.')
              // No PID probing for retired receipts. Only an intact cached
              // native settlement can validate a previously launched owner.
              if (read(journal, 'settled') === undefined)
                retain(name, 'Missing retired native settlement.')
              const result = inspectPosixOwnership(journal)
              if (result.state === 'retain') retain(name, result.reason)
            } else if (preflight === undefined) retain(name, 'Missing retired native receipt.')
          } else if (readdirSync(path).includes('native'))
            retain(name, 'Unexpected retired native evidence.')
        } else if (settled === undefined && preflight === undefined) {
          if (proof === 'native') {
            const result = inspectPosixOwnership(join(native, nonce!))
            if (result.state === 'retain') retain(name, result.reason)
            // Native SETTLED proves physical absence only. The distinct cold
            // kernel-absence path still works if caller finalization never began.
            if (result.state === 'confirmed' && result.proof === 'settled') {
              if (kind === 'pi' && caller === undefined)
                retain(name, 'Missing Pi output and caller settlement.')
              if (kind === 'fenced' && caller === undefined)
                retain(name, 'Missing fenced output and caller settlement.')
            }
          } else if (!(kind === 'pi' && caller !== undefined))
            retain(name, 'No explicit physical settlement.')
        }
        if (!suffix) links.add(id!)
        const retired = suffix ? path : `${path}.retired`
        confirmed.push(() => {
          if (!suffix) {
            if (settled === undefined) publish(path, 'settled', header + 'SETTLED\n')
            renameSync(path, retired)
          }
          removeRetired(retired, parent, (error) => recordFailure(retired, header, link!, error))
        })
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
      for (const retire of confirmed) retire()
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
