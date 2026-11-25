import {
  inWriteScope,
  vaultSandbox,
  takenDestination,
  copyIn,
  leftOutMessage,
  takenMessage,
  type JobsDeps,
  type Jobs,
  type JobResult,
  type Made,
} from './jobs'
/** Windows jobs own prelaunch admission, an authenticated native receipt and
 * every host finalizer. POSIX jobs instead retain native launch/caller journals
 * in jobs.ts. Both adapters share the job contract and pure file-scope rules. */
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { createInterface } from 'node:readline'
import { isSharedContentPath, vaultRelPath, type VaultRelPath } from '@holi/shared'
import { exactPath } from '@holi/shared/path-safety-node'
import {
  CapabilityError,
  joinOwnedProgram,
  spawnOwnedProgram,
  type ManagedOwnedChild,
  UnconfirmedOwnedProgramError,
} from '../../../../main/plugin-api'
import type { SessionSummary } from '../claude/listing'
import type { JobRun, JobsProvider } from '../provider'
import { bounded } from './bounded'
import { createWindowsJobRecovery } from './windows-job-recovery'

/**
 * Holi's id for a job: never a background job id or a PTY session's.
 * @public exported for its test
 */

/** How a job's process starts. Tests run small scripts through it. */
type SpawnJob = (
  bin: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string> },
) => ManagedOwnedChild

/** An owned Job Object on Windows, a detached process group on POSIX. */
const defaultSpawnJob: SpawnJob = (bin, args, { cwd, env }) =>
  spawnOwnedProgram(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })

const hashOf = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

/** Where a vault job runs and what it may write, absolute. */
interface VaultPlace {
  cwd: string
  writable: string[]
  readOnly: boolean
}

interface Job {
  id: string
  provider: JobsProvider
  name: string
  startedAt: number
  model?: string
  /** The scratch folder, or null for a job in the vault. */
  dir: string | null
  place: VaultPlace | null
  /** The agent's own state, outside what it may write. */
  state: string
  /** What a scratch job was given and wrote (`Made`). */
  made: Made
  child: ManagedOwnedChild | null
  /** A turn is under way: running, or its writes being copied back. */
  busy: boolean
  /** Admission is revoked before asynchronous retirement begins. */
  retiring?: boolean
  copyController?: AbortController
  finalizing?: boolean
  outcome?: 'completed' | 'failed'
  /** Why it failed, or what a completed turn left out. */
  message?: string
  /** Why it was stopped from outside, which is then its message. */
  stopped?: string
  /** The agent's thread, once it has said. */
  thread?: string
  /** Follow-ups waiting for the running turn to end. */
  queue: string[]
  tokens: number
  /** One observed settlement for admission, process ownership and finalization. */
  turnSettled: Promise<void>
  bracketBegin?: Promise<unknown>
  /** End the host's wait without authorizing finalization of an unproven launch. */
  abandonNativeWait?: (failure: unknown) => void
  windowsStopOperation?: Promise<void>
  marker?: string
  pidWrite?: Promise<void>
  finalizationError?: Error
  dropTimer?: ReturnType<typeof setTimeout>
  retirement?: Promise<void>
}

/** A write scope entry matches a path exactly, or as `folder/**` anything
 *  under the folder.
 * @public exported for its test
 */
const MAX_COPY_FILES = 200
const MAX_COPY_BYTES = 20 * 1024 * 1024
/** How many left-out paths a job's message names. */

/** The new folders a write scope names (`folder/**`). */
const newFolders = (write: readonly string[]): string[] =>
  write.filter((p) => p.endsWith('/**')).map((p) => p.slice(0, -3))

/** Every entry under `dir` that is not a folder (a link is not followed),
 *  vault-relative under `prefix`. */
async function entriesUnder(dir: string, prefix: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: string[] = []
  for (const entry of entries) {
    const rel = `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...(await entriesUnder(join(dir, entry.name), rel)))
    else out.push(rel)
  }
  return out
}

/**
 * The first new folder of `write` already in the vault at `root`, or null.
 * Case-blind where the disk is: on macOS `plan.app` is `Plan.app`.
 * @public exported for its test
 */
const collision = (rel: string): string =>
  `Holi did not copy back ${rel}: something else put it in the vault while the agent worked, and Holi never writes over it.`

/** Expected cancellation, propagated only after publication cleanup/rollback succeeds. */
class CopyBackCancelled extends Error {
  constructor() {
    super('Copy-back was cancelled.')
  }
}

/** A copy still owns preserved files or temporary state after failed cleanup. */
class CopyBackFinalizationError extends Error {}

/**
 * Write `data` at `abs` only if nothing is there: a file beside it, linked
 * into place, which fails when the name is taken (on a case-blind disk too)
 * however late that name came, then unlinked. False when it was taken.
 */
async function createExclusive(
  abs: string,
  data: Buffer,
  stopped: () => boolean,
): Promise<boolean> {
  await mkdir(dirname(abs), { recursive: true })
  const tmp = join(dirname(abs), `.holi-tmp-${randomBytes(6).toString('hex')}`)
  try {
    await writeFile(tmp, data)
    if (stopped()) throw new CopyBackCancelled()
    await link(tmp, abs)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  } finally {
    try {
      await rm(tmp, { force: true })
    } catch (err) {
      throw new CopyBackFinalizationError(`Could not clean up copy-back: ${String(err)}`)
    }
  }
}

/** Why a run did not start: where it would make something is taken. */
const MANIFEST = 'app.yaml'
const isManifest = (rel: string): boolean => rel === MANIFEST || rel.endsWith(`/${MANIFEST}`)

/** Every regular file under `dir`, vault-relative. A symlink is never
 *  followed: the job could point one anywhere. */
async function filesUnder(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(dir, prefix), { withFileTypes: true }).catch(() => [])
  const out: string[] = []
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...(await filesUnder(dir, rel)))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

/** A file's bytes, read only when it is still a regular file: a link is
 *  never followed. Null otherwise. */
async function readRegular(path: string): Promise<Buffer | null> {
  const stat = await lstat(path).catch(() => null)
  if (stat === null || !stat.isFile()) return null
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null)
  if (handle === null) return null
  try {
    return (await handle.stat()).isFile() ? await handle.readFile() : null
  } finally {
    await handle.close()
  }
}

/** The last line of what the process said on stderr, for a failure with no
 *  event to explain it. */
function lastLine(text: string): string {
  const lines = text.trim().split('\n')
  return lines[lines.length - 1]?.trim().slice(0, 300) ?? ''
}

/** The longest follow-up queue a job keeps. */
const MAX_QUEUE = 20

export function createWindowsJobs(deps: JobsDeps): Jobs {
  const log = deps.log ?? ((msg: string) => console.log(`[agent-jobs] ${msg}`))
  const spawnJob = deps.spawn ?? defaultSpawnJob
  const platform = 'win32' as NodeJS.Platform
  const windowsRecovery = platform === 'win32' ? createWindowsJobRecovery(deps.scratchRoot) : null
  const killGraceMs = deps.killGraceMs ?? 2_000
  const keepMs = deps.keepMs ?? 10 * 60_000
  const maxMs = deps.maxMs ?? 30 * 60_000
  const jobs = new Map<string, Job>()
  const managedTurns = new Map<
    string,
    NonNullable<ReturnType<NonNullable<JobsDeps['beginManagedTurn']>>>
  >()
  const bracket = async (id: string, edge: 'begin' | 'end' | 'forget') => {
    if (!deps.beginManagedTurn) return deps.bracket?.(id, edge)
    if (edge === 'begin') managedTurns.set(id, deps.beginManagedTurn(id))
    else {
      const turn = managedTurns.get(id)
      if (edge === 'end') await turn?.end()
      else turn?.forget()
      managedTurns.delete(id)
    }
  }
  let lastPushed = ''

  const summaries = (): SessionSummary[] =>
    [...jobs.values()].map((j) => ({
      id: j.id,
      provider: j.provider.id,
      name: j.name,
      state: j.busy && !j.finalizing ? 'working' : 'idle',
      startedAt: j.startedAt,
      ...(j.model === undefined ? {} : { model: j.model }),
      ...(j.tokens > 0 ? { usage: { total: j.tokens } } : {}),
      ...((j.busy && !j.finalizing) || j.outcome === undefined ? {} : { outcome: j.outcome }),
      ...((j.busy && !j.finalizing) || j.message === undefined
        ? {}
        : j.outcome === 'failed'
          ? { error: j.message }
          : { message: j.message }),
    }))

  function push(): void {
    const next = summaries()
    const encoded = JSON.stringify(next)
    if (encoded === lastPushed) return
    lastPushed = encoded
    deps.onChange(next)
  }

  /**
   * Signal the job's process, choosing the target from what the pid is now
   * (`pty.ts`, `signal()`, says why): the group only while it still leads
   * it, the child alone when it does not, nothing once it is gone.
   */
  async function kill(job: Job, why: string): Promise<void> {
    if (!job.busy) {
      if (job.finalizationError !== undefined) throw job.finalizationError
      return
    }
    if (job.windowsStopOperation !== undefined) return job.windowsStopOperation
    // Revoke admission and copy-back synchronously. Windows shares a single
    // stop deadline; a POSIX retry waits anew on the same turn settlement.
    job.stopped ??= why
    job.queue = []
    const settlement = job.turnSettled
    const operation = Promise.resolve().then(async () => {
      signal(job, 'SIGTERM')
      const escalation =
        platform === 'win32' ? undefined : setTimeout(() => signal(job, 'SIGKILL'), killGraceMs)
      try {
        await bounded(settlement, `Finalization of job ${job.id}`, killGraceMs + 5_000)
      } finally {
        clearTimeout(escalation)
      }
    })
    if (platform === 'win32') job.windowsStopOperation = operation
    job.copyController?.abort()
    return operation
  }

  function signal(job: Job, sig: 'SIGTERM' | 'SIGKILL'): void {
    const child = job.child
    if (child === null) return
    try {
      child.kill(sig)
    } catch {
      /* the native join classifies cleanup */
    }
  }

  /** Kill whatever the job's process left running in its group, so nothing
   *  changes the folder while it is copied back or the vault after its turn. */

  /** Move the current file aside atomically, then publish the replacement
   * only if the name remains free. The moved file is checked before publishing:
   * a sync write arriving after the caller's hash check is never replaced.
   * A competing file arriving while the name is free wins as well. */
  async function replaceKnown(
    abs: string,
    rel: VaultRelPath,
    data: Buffer,
    before: string,
    stopped: () => boolean,
  ) {
    const hold = await mkdtemp(join(dirname(abs), '.holi-copy-'))
    const previous = join(hold, 'previous')
    let moved = false
    let keep = false
    try {
      await rename(abs, previous)
      moved = true
      const old = await readRegular(previous)
      if (old === null || hashOf(old) !== before) throw new Error(collision(rel))
      await deps.beforePublish?.(rel)
      // Check an open descriptor's write before publishing the replacement.
      // A write after this check is the residual race the vault accepts.
      const after = await readRegular(previous)
      if (after === null || hashOf(after) !== before) throw new Error(collision(rel))
      if (stopped()) throw new CopyBackCancelled()
      if (!(await createExclusive(abs, data, stopped))) throw new Error(collision(rel))
    } catch (err) {
      if (moved) {
        try {
          // Restore independently of reads: even an unreadable original must
          // survive. A newly arrived file owns the name and is never replaced.
          await link(previous, abs)
        } catch (restore) {
          if ((restore as NodeJS.ErrnoException).code !== 'EEXIST') {
            keep = true
            throw new CopyBackFinalizationError(
              `${String(err)} Restoration failed: ${String(restore)}. The previous file is preserved at ${relative(deps.vault.root, previous)}.`,
            )
          }
          // Until comparison succeeds, both versions remain owned. A read or
          // close failure must not let finally delete the preserved original.
          keep = true
          try {
            const old = await readRegular(previous)
            keep = old === null || hashOf(old) !== before
          } catch (inspect) {
            throw new CopyBackFinalizationError(
              `${String(err)} Could not verify restoration: ${String(inspect)}. The previous file is preserved at ${relative(deps.vault.root, previous)}.`,
            )
          }
        }
      }
      if (keep) {
        throw new CopyBackFinalizationError(
          `${String(err)} The previous file is preserved at ${relative(deps.vault.root, previous)}.`,
        )
      }
      throw err
    } finally {
      if (!keep) {
        try {
          await rm(hold, { recursive: true, force: true })
        } catch (err) {
          throw new CopyBackFinalizationError(`Could not clean up copy-back: ${String(err)}`)
        }
      }
    }
  }

  /**
   * Copy back what the job wrote inside its scope, `app.yaml` last, stopping
   * where a Stop came in. Returns what it wrote and what it left out (not
   * the vault's shared content, or no longer a regular file). Throws with a
   * sentence when a path cannot be written or the job wrote too much.
   */
  async function copyBack(
    job: Pick<Job, 'stopped'> & { signal?: AbortSignal },
    dir: string,
    write: readonly string[],
    made: Made,
  ): Promise<{ written: number; skipped: string[] }> {
    const stopped = (): boolean => job.stopped !== undefined || job.signal?.aborted === true
    const skipped: string[] = []
    const allowed: { path: string; rel: VaultRelPath }[] = []
    let bytes = 0
    for (const path of (await filesUnder(dir)).filter((p) => inWriteScope(p, write))) {
      let rel: VaultRelPath
      try {
        rel = vaultRelPath(path)
      } catch {
        skipped.push(path)
        continue
      }
      if (!isSharedContentPath(rel)) {
        skipped.push(rel)
        continue
      }
      const stat = await lstat(join(dir, path)).catch(() => null)
      if (stat === null || !stat.isFile()) {
        skipped.push(rel)
        continue
      }
      bytes += stat.size
      allowed.push({ path, rel })
    }
    if (allowed.length > MAX_COPY_FILES || bytes > MAX_COPY_BYTES) {
      throw new Error(
        `The job wrote more than Holi copies back (${MAX_COPY_FILES} files, ${MAX_COPY_BYTES / 1024 / 1024} MB), so nothing was written.`,
      )
    }
    // A new folder holds only what this run wrote there, or nothing of it
    // is written: whatever else is in it came from somewhere else meanwhile.
    for (const folder of newFolders(write)) {
      if (!allowed.some(({ rel }) => rel.startsWith(`${folder}/`))) continue
      const theirs = (await entriesUnder(join(deps.vault.root, folder), folder)).filter(
        (rel) => !made.has(rel),
      )
      if (theirs.length > 0) {
        throw new Error(collision(folder))
      }
    }
    // What it was given or wrote before is written again only while the
    // vault still holds that, and only when the run changed it since.
    const pending: { path: string; rel: VaultRelPath; data: Buffer; hash: string }[] = []
    for (const { path, rel } of allowed) {
      const data = await readRegular(join(dir, path))
      if (data === null) {
        skipped.push(rel)
        continue
      }
      const hash = hashOf(data)
      const before = made.get(rel)
      if (before === hash) continue
      if (before !== undefined) {
        const now = await readRegular(join(deps.vault.root, rel))
        if (now === null || hashOf(now) !== before) {
          throw new Error(
            `Holi did not copy back what the agent wrote: ${rel} changed in the vault since the agent wrote it, and Holi never writes over it.`,
          )
        }
      }
      pending.push({ path, rel, data, hash })
    }
    const ordered = [
      ...pending.filter(({ rel }) => !isManifest(rel)),
      ...pending.filter(({ rel }) => isManifest(rel)),
    ]
    let written = 0
    for (const { rel, data, hash } of ordered) {
      if (stopped()) break
      const abs = await exactPath(deps.vault.root, rel)
      if (abs === null) throw new Error(`Holi could not write ${rel}.`)
      if (stopped()) break
      const before = made.get(rel)
      if (before === undefined) {
        // A new file: written only where nothing is, even something that
        // arrived after the checks above (a sync bringing the same app).
        if (stopped()) break
        if (!(await createExclusive(abs, data, stopped))) throw new Error(collision(rel))
      } else {
        // What this run was given or wrote before: written over only while
        // the vault still holds exactly that, read again just before.
        const now = await readRegular(abs)
        if (now === null || hashOf(now) !== before) {
          throw new Error(
            `Holi did not copy back what the agent wrote: ${rel} changed in the vault since the agent wrote it, and Holi never writes over it.`,
          )
        }
        await deps.beforeReplace?.(rel)
        if (stopped()) break
        await replaceKnown(abs, rel, data, before, stopped)
      }
      made.set(rel, hash)
      written += 1
      await deps.afterWrite?.(rel)
    }
    return { written, skipped }
  }

  const pidFile = (id: string): string => join(deps.scratchRoot, `${id}.pid`)

  /** The job leaves the list, and its agent's state goes with it. */
  async function retire(job: Job): Promise<void> {
    // Revoke admission before the first asynchronous filesystem operation.
    job.retiring = true
    job.queue = []
    clearTimeout(job.dropTimer)
    if (job.finalizationError !== undefined) throw job.finalizationError
    if (job.retirement === undefined) {
      const retirement = (async () => {
        await job.turnSettled
        if (job.finalizationError !== undefined) throw job.finalizationError
        await job.pidWrite
        await rm(job.state, { recursive: true, force: true })
        if (jobs.get(job.id) === job) jobs.delete(job.id)
        push()
      })()
      job.retirement = retirement
      // Only a settled failure permits another attempt. A timed-out deletion
      // still owns the namespace and every retry joins that same operation.
      void retirement.catch(() => {
        if (job.retirement === retirement) job.retirement = undefined
      })
    }
    await job.retirement
  }

  function drop(job: Job): Promise<void> {
    return bounded(retire(job), `Cleanup of job ${job.id}`)
  }

  /** The job's turn ended: its outcome stands until a follow-up starts
   *  another, and it leaves the list a while after the last. */
  async function finish(
    job: Job,
    outcome: 'completed' | 'failed',
    message?: string,
  ): Promise<void> {
    job.outcome = outcome
    if (message === undefined) delete job.message
    else job.message = message
    job.child = null
    const cleanups = [
      ...(platform === 'win32'
        ? []
        : [
            (async () => {
              await job.pidWrite
              await rm(pidFile(job.id), { force: true })
            })(),
          ]),
      // A failed provider release still owns this state. Retain both folders
      // with the captured job rather than destroying what could not be drained.
      ...(job.dir === null || job.finalizationError !== undefined
        ? []
        : [
            rm(job.dir, { recursive: true, force: true }),
            rm(job.state, { recursive: true, force: true }),
          ]),
    ]
    const results = await Promise.allSettled(cleanups)
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    )
    if (errors.length > 0) {
      job.finalizationError = new AggregateError(
        [job.finalizationError, ...errors].filter(Boolean),
        `Could not clean up job ${job.id}.`,
      )
      job.outcome = 'failed'
      job.message = job.finalizationError.message
    }
    clearTimeout(job.dropTimer)
    push()
  }

  /** One turn owns everything from pre-spawn admission through finalization.
   * Start waits for admission; Stop also joins the work behind it. */
  function runTurn(
    job: Job,
    run: JobRun,
    write: readonly string[],
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    run = { ...run, binDir: deps.binDir?.() }
    const { id, provider } = job
    job.busy = true
    delete job.windowsStopOperation
    clearTimeout(job.dropTimer)
    let admit!: (result: { ok: true } | { ok: false; message: string }) => void
    const admission = new Promise<{ ok: true } | { ok: false; message: string }>((resolve) => {
      admit = resolve
    })
    const revoked = () =>
      closing ||
      deps.activationSignal?.aborted === true ||
      job.retiring ||
      job.stopped !== undefined
    const gone = 'The vault was left before the job started.'
    const refused = async (message: string) => {
      // Command preparation may already own provider state, even with no child.
      // The first POSIX refusal retains its existing cleanup semantics.
      job.finalizing = true
      if (platform === 'win32' || run.resume !== undefined) {
        try {
          await provider.release?.(job.state)
        } catch (err) {
          job.finalizationError = new Error(`Could not release agent state: ${String(err)}`)
        }
      }
      await finish(job, 'failed', message)
      if (run.resume === undefined && job.finalizationError === undefined && job.dir === null)
        await rm(job.state, { recursive: true, force: true })
      await windowsRecovery?.removeMarker(job)
      job.queue = []
      job.busy = false
      job.finalizing = false
      if (run.resume === undefined && job.finalizationError === undefined) jobs.delete(id)
      else scheduleDrop(job)
      admit({ ok: false, message })
      if (job.finalizationError !== undefined) throw job.finalizationError
      push()
    }
    const turn = async () => {
      if (revoked()) return refused(job.stopped ?? gone)
      let command: ReturnType<JobsProvider['capabilities']['jobs']['command']>
      try {
        command = provider.capabilities.jobs.command(run)
      } catch (err) {
        return refused((err as Error).message)
      }
      if (command === null) return refused(provider.notInstalled)
      if (windowsRecovery !== null) {
        push()
        if (revoked()) return refused(job.stopped ?? gone)
        try {
          await windowsRecovery.publishMarker(job)
        } catch (err) {
          return refused(`Could not publish Windows job recovery marker: ${String(err)}`)
        }
      }
      // No await (or call out to observers) between the final check and spawn.
      if (revoked()) return refused(job.stopped ?? gone)
      let child: ManagedOwnedChild
      try {
        child = spawnJob(command.bin, command.args, { cwd: run.cwd, env: command.env })
      } catch (err) {
        if (platform === 'win32') {
          // Definitive no-helper failures use the adapter's not-started result.
          throw err instanceof UnconfirmedOwnedProgramError
            ? err
            : new UnconfirmedOwnedProgramError(err)
        }
        return refused(`${provider.label} did not start: ${(err as Error).message}`)
      }
      // Subscribe before any branch: even the local no-helper child emits error.
      const joined = joinOwnedProgram(child, platform)
      job.child = child
      if (platform !== 'win32' && child.pid !== undefined) {
        const line = `${child.pid}\n${run.cwd}\n`
        job.pidWrite = mkdir(deps.scratchRoot, { recursive: true }).then(() =>
          writeFile(pidFile(id), line),
        )
        void job.pidWrite.catch(() => {})
      }
      const bracketBegin =
        job.place === null
          ? undefined
          : Promise.resolve()
              .then(() => bracket(id, 'begin'))
              .catch((err) => {
                job.finalizationError ??= new Error(`Could not begin job turn: ${String(err)}`)
              })
      if (bracketBegin !== undefined) job.bracketBegin = bracketBegin

      let completed = false
      let failure: string | null = null
      let error: string | null = null
      let stderr = ''
      const lines = child.stdout === null ? undefined : createInterface({ input: child.stdout })
      // Readline forwards stdin errors; the shared join records the raw error.
      lines?.on('error', () => {})
      lines?.on('line', (line) => {
        const event = provider.capabilities.jobs.event(line)
        if (event === null) return
        if (event.kind === 'thread') {
          job.thread ??= event.id
          log(`${id}: thread ${event.id}`)
        } else if (event.kind === 'turn-completed') {
          completed = true
          if (event.tokens !== undefined) {
            job.tokens = event.tokens
            push()
          }
        } else if (event.kind === 'turn-failed') failure = event.message
        else if (event.kind === 'error') error = event.message
      })
      const collectStderr = (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-4_000)
      }
      child.stderr?.on('data', collectStderr)
      const tooLong = setTimeout(() => {
        void kill(job, 'The job ran too long and was stopped.').catch((err: unknown) => {
          log(`${id}: could not stop: ${String(err)}`)
        })
      }, maxMs)
      tooLong.unref?.()
      admit({ ok: true })
      let result
      try {
        push()
        if (platform === 'win32') {
          const abandoned = new Promise<never>((_, reject) => {
            job.abandonNativeWait = reject
          })
          result = await Promise.race([joined, abandoned])
        } else result = await joined
      } finally {
        delete job.abandonNativeWait
        clearTimeout(tooLong)
        lines?.close()
        lines?.removeAllListeners('line')
        child.stderr?.off('data', collectStderr)
      }
      const { code, signal: sig, error: commandError, ownership } = result
      job.child = null
      await bracketBegin
      let releaseFailure: string | undefined
      try {
        await provider.release?.(job.state)
      } catch (err) {
        releaseFailure = `Could not release agent state: ${String(err)}`
        job.finalizationError = new Error(releaseFailure)
      }
      if (releaseFailure === undefined && job.finalizationError !== undefined) {
        releaseFailure = job.finalizationError.message
      }
      let outcome: 'completed' | 'failed'
      let why: string | undefined
      if (job.stopped !== undefined) {
        outcome = 'failed'
        why = job.stopped
      } else if (releaseFailure !== undefined) {
        outcome = 'failed'
        why = releaseFailure
      } else if (
        completed &&
        failure === null &&
        commandError === null &&
        code === 0 &&
        ownership !== 'not-started'
      ) {
        outcome = 'completed'
        if (job.dir !== null) {
          try {
            job.copyController = new AbortController()
            const { written, skipped } = await copyBack(
              { ...job, signal: job.copyController.signal },
              job.dir,
              write,
              job.made,
            )
            log(`${id}: done, ${written} file(s) written, ${skipped.length} left out`)
            why = leftOutMessage(skipped) ?? why
          } catch (err) {
            outcome = 'failed'
            why = (err as Error).message
            // A rejected publication is settled after successful restoration.
            // Failed restoration or cleanup still owns preserved state and
            // must prevent a successful stop or vault drain.
            if (err instanceof CopyBackFinalizationError) {
              job.finalizationError = err instanceof Error ? err : new Error(String(err))
            }
          }
          // Stop wins over safe cancellation, not an unconfirmed restoration.
          if (job.stopped !== undefined && job.finalizationError === undefined) {
            outcome = 'failed'
            why = job.stopped
          }
        } else log(`${id}: turn done`)
      } else {
        outcome = 'failed'
        why =
          (platform === 'win32' && commandError !== null
            ? ownership === 'not-started'
              ? `${provider.label} did not start: ${commandError.message}`
              : commandError.message
            : null) ??
          failure ??
          error ??
          (commandError === null
            ? null
            : `${provider.label} did not start: ${commandError.message}`) ??
          (ownership === 'not-started' ? `${provider.label} did not start.` : null) ??
          (sig !== null
            ? `${provider.label} was stopped (${sig}).`
            : `${provider.label} exited with code ${code ?? '?'}${lastLine(stderr) === '' ? '.' : `: ${lastLine(stderr)}`}`)
        log(`${id}: failed: ${why}`)
      }
      job.finalizing = true
      // Persist the turn before making its outcome visible. Stop joins
      // persistence, owned cleanup and marker removal as part of this turn.
      if (job.place !== null) {
        try {
          await bracket(id, 'end')
        } catch (err) {
          job.finalizationError = new Error(`Could not finalize job turn: ${String(err)}`)
        }
      }
      if (job.finalizationError !== undefined) throw job.finalizationError
      await finish(job, outcome, why)
      await windowsRecovery?.removeMarker(job)
      if (job.finalizationError !== undefined) throw job.finalizationError
      if (job.stopped !== undefined) {
        job.outcome = 'failed'
        job.message = job.stopped
      }
      if (ownership === 'not-started') job.queue = []
      job.finalizing = false
      job.busy = false
      scheduleDrop(job)
      push()
      followUp(job)
    }
    // Install the settlement before running command preparation or notifying
    // observers; either may synchronously revoke admission.
    job.turnSettled = Promise.resolve()
      .then(turn)
      .catch((err: unknown) => {
        // Preserve the shared join's exact failure and its launch-specific lease.
        // A late close cannot turn this rejection into permission to clean up.
        const failure = err instanceof Error ? err : new Error(String(err))
        job.finalizationError = failure
        job.outcome = 'failed'
        job.message = failure.message
        job.busy = false
        job.finalizing = false
        job.queue = []
        admit({ ok: false, message: failure.message })
        push()
        throw failure
      })
    void job.turnSettled.catch(() => {})
    return admission
  }

  function scheduleDrop(job: Job): void {
    if (closing || job.finalizationError !== undefined || job.retiring) return
    clearTimeout(job.dropTimer)
    job.dropTimer = setTimeout(() => {
      if (jobs.get(job.id) === job) {
        void drop(job).catch((err: unknown) => log(`${job.id}: could not clean up: ${String(err)}`))
      }
    }, keepMs)
    job.dropTimer.unref?.()
  }

  /** Send what is queued as one turn on the job's thread. */
  function followUp(job: Job): void {
    const place = job.place
    if (
      closing ||
      job.busy ||
      job.retiring ||
      job.stopped !== undefined ||
      job.finalizationError !== undefined ||
      place === null ||
      job.thread === undefined ||
      job.queue.length === 0
    )
      return
    const text = job.queue.join('\n\n')
    job.queue = []
    void runTurn(
      job,
      {
        cwd: place.cwd,
        root: deps.vault.root,
        prompt: text,
        writable: place.writable,
        readOnly: place.readOnly,
        resume: job.thread,
        state: job.state,
        ...(job.model === undefined ? {} : { model: job.model }),
      },
      [],
    )
  }

  /** The vault folders a job may write, made where missing, each checked to
   *  have no symlink on the way. */
  async function placeIn(write: readonly string[]): Promise<VaultPlace | string> {
    const abs: string[] = []
    for (const rel of write) {
      const path = await exactPath(deps.vault.root, rel)
      if (path === null) return `Holi could not make ${rel} writable.`
      await mkdir(path, { recursive: true })
      abs.push(path)
    }
    const [first, ...rest] = abs
    return first === undefined
      ? { cwd: deps.vault.root, writable: [], readOnly: true }
      : { cwd: first, writable: rest, readOnly: false }
  }

  // Scratch folders a crash left behind. A job that outlived it is killed
  // first, when its pid still leads a group whose command names the folder
  // it ran in (a pid is reused); then the folders go. A job starts once
  // they are gone.
  const sweeping = windowsRecovery!.verifyScratch()
  const swept = bounded(sweeping, 'Agent job state sweep')
  void swept.catch(() => {})

  let closing = deps.activationSignal?.aborted === true
  let cancelAdmission!: () => void
  const revokedAdmission = new Promise<void>((resolve) => {
    cancelAdmission = resolve
  })
  // Starts queued at recovery have no workspace ownership yet. Wake them on
  // revocation without waiting for recovery (or any running job) to finish.
  const ready = Promise.race([swept, revokedAdmission])
  void ready.catch(() => {})
  function closeAdmission(): void {
    closing = true
    cancelAdmission()
  }
  /** FS work admitted before the first turn takes ownership. */
  const starting = new Set<Promise<JobResult>>()
  deps.activationSignal?.addEventListener(
    'abort',
    () => {
      closeAdmission()
      for (const job of jobs.values()) {
        job.queue = []
        clearTimeout(job.dropTimer)
        void kill(job, 'Stopped.').catch((err: unknown) => {
          log(`${job.id}: could not stop: ${String(err)}`)
        })
      }
    },
    { once: true },
  )

  /** A job's start, up to its first turn's spawn. Between its awaits the
   *  vault may be left; it then stops there, before anything runs. */
  async function begin(spec: Parameters<Jobs['start']>[0], onTurn: () => void): Promise<JobResult> {
    const { provider, name, prompt, system, model } = spec
    const id = `j${randomBytes(6).toString('hex')}`
    const job: Job = {
      id,
      provider,
      name,
      startedAt: Date.now(),
      ...(model === undefined ? {} : { model }),
      dir: null,
      place: null,
      state: join(deps.scratchRoot, `${id}.agent`),
      made: new Map(),
      child: null,
      busy: false,
      queue: [],
      tokens: 0,
      turnSettled: Promise.resolve(),
    }

    const gone = { ok: false, message: 'The vault was left before the job started.' } as const
    const base = {
      root: deps.vault.root,
      state: job.state,
      ...(model === undefined ? {} : { model }),
    }
    let run: JobRun
    let write: readonly string[]
    let transferred = false
    try {
      await mkdir(job.state, { recursive: true, mode: 0o700 })
      if (closing) return gone
      if ('allow' in spec) {
        const sandbox = vaultSandbox(spec.allow)
        if (!sandbox.ok) return sandbox
        const place = await placeIn(sandbox.write)
        if (typeof place === 'string') return { ok: false, message: place }
        job.place = place
        // Every path a vault job is given is relative to this vault.
        const where = `The vault is ${deps.vault.root}. Every vault path named here is relative to it.`
        run = {
          ...base,
          cwd: place.cwd,
          prompt: [system, where, prompt].filter((p) => p !== undefined).join('\n\n'),
          writable: place.writable,
          readOnly: place.readOnly,
        }
        write = []
      } else {
        const { scope } = spec
        const taken = await takenDestination(deps.vault.root, scope.write)
        if (taken !== null) return { ok: false, message: takenMessage(taken) }
        if (closing) return gone
        const dir = (job.dir = join(deps.scratchRoot, id))
        await mkdir(dir, { recursive: true })
        if (closing) return gone
        const unread = await copyIn(deps.vault.root, dir, scope.read, job.made)
        if (unread !== null) return { ok: false, message: unread }
        run = {
          ...base,
          cwd: dir,
          prompt: system === undefined ? prompt : `${system}\n\n${prompt}`,
        }
        write = scope.write
      }
      if (closing) return gone
      // No await between preparation and the turn taking ownership.
      jobs.set(id, job)
      transferred = true
      onTurn()
      const started = await runTurn(job, run, write)
      return started.ok ? { ok: true, sessionId: id } : started
    } finally {
      if (!transferred) {
        // These paths never reached a turn, so no provider or child owns them.
        await Promise.allSettled(
          [job.state, ...(job.dir === null ? [] : [job.dir])].map((path) =>
            rm(path, { recursive: true, force: true }),
          ),
        )
      }
    }
  }

  let leaving: Promise<void> | undefined
  let rootRetirement: Promise<void> | undefined
  let drained = false

  async function drain(): Promise<void> {
    const all = [...jobs.values()]
    const preparing = Promise.allSettled(starting)
    for (const job of all) {
      job.retiring = true
      job.queue = []
      clearTimeout(job.dropTimer)
    }
    const stopFailures = windowsRecovery?.stopFailures()
    const stopping = Promise.allSettled(
      all.map(async (job) => {
        try {
          await kill(job, 'Stopped.')
        } catch (failure) {
          stopFailures?.record(failure)
          // A timed-out Windows launch may still be alive. The native join
          // keeps observing it; late proof cannot start new host finalizers.
          job.abandonNativeWait?.(failure)
          throw failure
        }
      }),
    )
    const hostWork =
      platform === 'win32'
        ? Promise.allSettled(
            all.flatMap((job) => [job.turnSettled, job.bracketBegin, job.retirement]),
          )
        : undefined
    const [stops, [recovery, starts, host]] = await Promise.all([
      stopping,
      Promise.allSettled([
        bounded(sweeping, 'Agent job state sweep'),
        platform === 'win32' ? preparing : bounded(preparing, 'Agent job starts'),
        hostWork,
      ] as const),
    ])
    const failures = stops.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    )
    // A failed Stop is not a barrier: all host work above must settle first.
    stopFailures?.throwFirst()
    if (failures.length > 0)
      throw new AggregateError(failures, 'One or more agent jobs did not drain.')
    if (recovery.status === 'rejected') throw recovery.reason
    for (const phase of [starts, host]) {
      if (phase.status === 'rejected') throw phase.reason
      const failure = phase.value?.find((result) => result.status === 'rejected')
      if (failure !== undefined) throw failure.reason
    }
    const retired = await Promise.allSettled(all.map(platform === 'win32' ? retire : drop))
    const failure = retired.find((result) => result.status === 'rejected')
    if (failure !== undefined) throw failure.reason
    if (rootRetirement === undefined) {
      const retirement =
        windowsRecovery === null
          ? rm(deps.scratchRoot, { recursive: true, force: true })
          : windowsRecovery.removeEmptyRoot()
      rootRetirement = retirement
      void retirement.catch(() => {
        if (rootRetirement === retirement) rootRetirement = undefined
      })
    }
    if (platform === 'win32') await rootRetirement
    else await bounded(rootRetirement, 'Agent job root cleanup')
    drained = true
    push()
  }

  return {
    sessions: summaries,
    has: (id) => jobs.has(id),

    async start(spec) {
      if (closing) return { ok: false, message: 'The vault is closing.' }
      try {
        await ready
      } catch (err) {
        return { ok: false, message: `Could not sweep agent job state: ${String(err)}` }
      }
      if (closing) return { ok: false, message: 'The vault was left before the job started.' }
      const begun = begin(spec, () => starting.delete(begun))
      starting.add(begun)
      try {
        return await begun
      } finally {
        starting.delete(begun)
      }
    },

    message(id, text) {
      const job = jobs.get(id)
      if (
        job === undefined ||
        job.retiring ||
        job.finalizing ||
        job.finalizationError !== undefined ||
        closing
      )
        throw new CapabilityError('UNAVAILABLE', 'That job has ended.')
      if (job.place === null) {
        throw new CapabilityError(
          'UNAVAILABLE',
          'A job in a scratch folder takes no follow-up: it ends with its one turn.',
        )
      }
      // Its process is being stopped: a message now would start it again.
      if (job.busy && job.stopped !== undefined) {
        throw new CapabilityError('UNAVAILABLE', 'That job is being stopped.')
      }
      if (job.queue.length >= MAX_QUEUE) {
        throw new CapabilityError('UNAVAILABLE', 'That job has too many messages waiting.')
      }
      job.queue.push(text)
      // A turn running sends it when it ends; an idle thread takes it now.
      if (job.busy) return
      if (job.thread === undefined) {
        job.queue = []
        throw new CapabilityError('UNAVAILABLE', 'That job never said which thread it was.')
      }
      void followUp(job)
    },

    async stop(id) {
      const job = jobs.get(id)
      if (job === undefined) return { ok: false, message: 'That job has ended.' }
      if (job.busy) await kill(job, 'Stopped.')
      // A finished one leaves the list.
      else {
        if (job.finalizationError !== undefined) throw job.finalizationError
        // Leave owns cleanup now; don't start another retirement behind its join.
        if (platform !== 'win32' || !closing || job.retirement !== undefined) await drop(job)
        push()
      }
      return { ok: true }
    },

    async leave() {
      if (drained) return
      if (leaving === undefined) {
        closeAdmission()
        // Publish the join before stopping turns: abort handlers can reenter leave.
        let resolve!: () => void
        let reject!: (reason: unknown) => void
        leaving = new Promise<void>((res, rej) => {
          resolve = res
          reject = rej
        }).finally(() => {
          leaving = undefined
        })
        void drain().then(resolve, reject)
      }
      await leaving
    },

    copyBack: (dir, write, made, signal) => copyBack({ signal }, dir, write, made),
  }
}
