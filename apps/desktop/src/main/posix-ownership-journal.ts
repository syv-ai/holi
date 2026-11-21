import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'
import { receiptPid } from './posix-lease-protocol'

const code = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code

export function posixAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if (code(error) === 'ESRCH') return true
    if (code(error) === 'EPERM') return false
    throw error
  }
}

const refusals = new WeakMap<object, { readonly cleanup: Promise<void> }>()

/** Positive proof that the Provider was not admitted. Retirement still requires cleanup. */
export function posixLaunchNonAdmission(error: unknown) {
  return error instanceof Object ? refusals.get(error) : undefined
}

export function markPosixNonAdmission(error: unknown, cleanup: Promise<void>) {
  void cleanup.catch(() => {})
  if (error instanceof Object) refusals.set(error, { cleanup })
}

const plainDir = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const readFlags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
const header = (path: string) => `HOLI-POSIX-1 ${basename(path)}\n`
const limit = 1024

function validatePath(path: string) {
  if (
    !isAbsolute(path) ||
    normalize(path) !== path ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(basename(path))
  )
    throw new Error('Expected a fresh POSIX ownership record path named by a random UUID.')
}

function syncDir(path: string) {
  const fd = openSync(path, plainDir)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function writePrivate(path: string, text: string) {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    writeFileSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function readPrivate(path: string): string | undefined {
  let fd: number
  try {
    fd = openSync(path, readFlags)
  } catch (error) {
    if (code(error) === 'ENOENT') return
    throw error
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || stat.mode & 0o077)
      throw new Error('POSIX ownership evidence is not a private regular file.')
    const bytes = Buffer.alloc(limit + 1)
    let length = 0
    while (length < bytes.length) {
      const n = readSync(fd, bytes, length, bytes.length - length, null)
      if (!n) break
      length += n
    }
    if (length > limit) throw new Error('Oversized POSIX ownership evidence.')
    return bytes.toString('utf8', 0, length)
  } finally {
    closeSync(fd)
  }
}

function readJournal(path: string) {
  const text = readPrivate(join(path, 'journal'))
  if (text === undefined) return
  if (!text.startsWith(header(path)) || !text.endsWith('\n'))
    throw new Error('Invalid POSIX ownership journal framing or launch identity.')
  const lines = text.slice(header(path).length).split('\n').slice(0, -1)
  const ids: number[] = []
  let complete = false
  let failure: string | undefined
  for (const line of lines) {
    const error = /^ERROR ([a-z-]{1,32}) ([1-9]\d{0,9})$/.exec(line)
    if (error) {
      failure ??= `native ${error[1]} (errno ${error[2]})`
      continue
    }
    if (!failure && !complete && line === 'COMPLETE' && ids.length === 3) {
      complete = true
      continue
    }
    const record = /^(ROOT|REAPER|ANCHOR) ([1-9]\d{0,9})$/.exec(line)
    if (failure || complete || !record || record[1] !== ['ROOT', 'REAPER', 'ANCHOR'][ids.length])
      throw new Error('Invalid POSIX ownership journal sequence.')
    const pid = receiptPid(record[2]!)
    if (ids.includes(pid)) throw new Error('Duplicate POSIX ownership identity.')
    ids.push(pid)
  }
  return { text, ids, complete, failure }
}

type FailureStage = 'protocol' | 'drain' | 'cancel' | 'preparation' | 'settlement'

/** The caller publishes its link before this exclusive, one-shot claim. */
export function openPosixOwnershipJournal(recordPath: string | undefined) {
  if (recordPath === undefined) return
  const path = recordPath
  validatePath(path)
  const parent = lstatSync(dirname(path))
  if (!parent.isDirectory() || parent.uid !== process.getuid!() || parent.mode & 0o077)
    throw new Error('The POSIX ownership record needs a private parent directory.')
  mkdirSync(path, { mode: 0o700 })
  const journal = join(path, 'journal')
  writePrivate(journal, header(path))
  syncDir(path)
  syncDir(dirname(path))
  let failed = false
  function publish(name: 'settled' | 'failed', line: string) {
    const file = join(path, name)
    const stage = file + '.tmp'
    writePrivate(stage, header(path) + line + '\n')
    renameSync(stage, file)
    syncDir(path)
  }
  return {
    journal,
    fail(stage: FailureStage) {
      if (failed) return
      failed = true
      publish('failed', `FAILED ${stage}`)
    },
    settle() {
      const state = readJournal(path)
      if (failed || !state || state.failure)
        throw new Error('Cannot settle a failed POSIX ownership journal.')
      publish('settled', 'SETTLED')
    },
  }
}

/** @public Node-only result exposed by the main plugin seam. */
export type PosixOwnershipInspection =
  | { readonly state: 'confirmed'; readonly proof: 'settled' | 'kernel-absence' }
  | { readonly state: 'retain'; readonly reason: string }

/** Cold inspection only, with the owning controller no longer launching. No signal
 * authority is reconstructed from disk; only read-only kernel probes are used.
 * @public Node-only main plugin seam.
 */
export function inspectPosixOwnership(path: string): PosixOwnershipInspection {
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    return { state: 'retain', reason: 'Unsupported POSIX ownership platform.' }
  const retain = (reason: string) => ({ state: 'retain' as const, reason })
  try {
    validatePath(path)
    for (const directory of [dirname(path), path]) {
      const stat = lstatSync(directory)
      if (!stat.isDirectory() || stat.uid !== process.getuid!() || stat.mode & 0o077)
        return retain('POSIX ownership directory is not private.')
    }
    const terminal = () => {
      for (const name of ['failed.tmp', 'settled.tmp']) {
        if (readPrivate(join(path, name)) !== undefined)
          throw new Error('Partial POSIX ownership terminal record.')
      }
      const failed = readPrivate(join(path, 'failed'))
      if (failed !== undefined) {
        const stage = /^FAILED (protocol|drain|cancel|preparation|settlement)\n$/.exec(
          failed.slice(header(path).length),
        )
        if (!failed.startsWith(header(path)) || !stage)
          throw new Error('Invalid POSIX ownership failure record.')
        return retain(`POSIX ownership cleanup failed (${stage[1]}).`)
      }
      const settled = readPrivate(join(path, 'settled'))
      if (settled === undefined) return
      if (settled !== header(path) + 'SETTLED\n')
        throw new Error('Invalid POSIX ownership settlement.')
      return { state: 'confirmed' as const, proof: 'settled' as const }
    }
    const journal = readJournal(path)
    const final = terminal()
    if (journal?.failure) return retain(`POSIX ownership journal reports ${journal.failure}.`)
    if (!journal) return retain('Missing POSIX ownership journal.')
    if (final) return final
    if (!journal.complete) return retain('Incomplete POSIX ownership journal.')
    const [root, reaper, anchor] = journal.ids as [number, number, number]
    if (![reaper, -reaper, anchor, root, -root].every(posixAbsent))
      return retain('POSIX ownership still has a PID or group in the kernel.')
    // No writers remain after absence. Re-read to catch a native error appended
    // between the first read and the last process/group leaving the kernel.
    if (readJournal(path)?.text !== journal.text) return retain('POSIX ownership journal changed.')
    return terminal() ?? { state: 'confirmed', proof: 'kernel-absence' }
  } catch (error) {
    const errno = code(error)
    return retain(errno ? `Cannot read or probe POSIX ownership (${errno}).` : String(error))
  }
}
