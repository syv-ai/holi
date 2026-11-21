/**
 * Jobs: a prompt run with nobody watching, for a provider with no supervisor
 * of its own but a way to run unattended (`jobs`, Codex's `codex exec`).
 * docs/features/agent-sessions.md, Jobs.
 *
 * **Two places a job runs**, each sandboxed by the agent's own rules:
 *
 * - **A scratch folder** (`scope`, a document's agent): Holi makes one of its
 *   own (`<userData>/agent-scratch/<vault-key>/jobs/<id>/`), copies in the
 *   files the job may read, at their vault paths, and runs the agent there. What bounds it is
 *   what it writes back, not what it reads: Codex's sandbox keeps writes to
 *   the folder but can read the disk. When it succeeds, its process group is
 *   killed, then only the regular files it wrote that match its write scope
 *   and are the vault's shared content (`isSharedContentPath`: nothing
 *   hidden, local, secret, on the agent surface or named
 *   `AGENTS.md`/`CLAUDE.md`) are copied back, each checked as a vault path
 *   with no symlink on the way, and any `app.yaml` last: a vault app's
 *   finished marker lands after its page. What it left out it names in its
 *   message. Past `MAX_COPY_FILES` or `MAX_COPY_BYTES` nothing is copied and
 *   it fails. A failed or stopped job copies nothing back, and a Stop during
 *   the copy stops it there. The folder is deleted either way. A new folder
 *   is never written over: a `folder/**` in the write scope (Create vault
 *   app's `<name>.app`) must not be in the vault when the run starts, and at
 *   each copy everything in it must be what this run wrote there; when sync
 *   or anything else put it there meanwhile, the copy is refused in words
 *   and nothing of it is written (`takenDestination`, `copyBack`).
 * - **The vault** (`allow`, a Holi's or an automation's run): Claude Code
 *   permission rules, which run here only when each is a folder the sandbox
 *   can make writable, or a read (`vaultSandbox`). The agent runs in the
 *   first such folder, writes the others too and nothing else; with none it
 *   is read-only. Its turns go through the vault's turn bracket, so sync
 *   pauses and each turn is recorded under the job's id, like a session's.
 *   Nothing is copied: the sandbox's writable folders are what bounds it.
 *
 * Either way the agent gets a state folder of its own (`<id>.agent/`, its
 * own Codex home, say), beside the scratch folders and outside what any job
 * may write, kept across a vault job's turns. Once a turn's process exits
 * the provider takes back what it keeps of the person's there
 * (`AgentProvider.release`), and it goes with the job.
 *
 * POSIX turns retain a launch lease that drains the group on exit or stop
 * and handles parent death through control EOF. Recovery joins the durable
 * launch registry with a caller receipt; a POSIX PID file is diagnostic only.
 *
 * **It is a session in the one list**, named by Holi's id (`j` and twelve hex
 * digits): working while a turn runs, then idle with its `outcome` (and why,
 * when it failed) for a while, so whoever started it reads the result off the
 * row: `completed` or `failed`, as a Pi run's, why it failed as its `error`.
 * Codex's `usage.total` is the latest reported cumulative thread total.
 *
 * **A follow-up** (`message`) to a vault job is a new turn on the agent's
 * thread (`resume`): queued while a turn runs, sent when it ends. The agent
 * has no way to take a message mid-turn from Holi.
 *
 * NOTE: no `electron` import, so this loads under vitest.
 */
import { createHash, randomBytes } from 'node:crypto'
import { constants, linkSync, renameSync } from 'node:fs'
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { isHiddenPath, isSharedContentPath, vaultRelPath, type VaultRelPath } from '@holi/shared'
import { exactPath } from '@holi/shared/path-safety-node'
import { CapabilityError, readableOrNull } from '../../../../main/plugin-api'
import type { SessionSummary } from '../claude/listing'
import type { JobRun, JobsProvider, VaultRef } from '../provider'
import { createWindowsJobs } from './windows-jobs'
import { bounded } from './bounded'
import { jobScratch, type JobFiles, type JobTurnReceipt } from './job-receipts'
import { startJobTurn } from './job-turn'
import type { ActionResult } from './sessions'
import type { ManagedTurn } from './turn-coordinator'

/** What a job may touch: files it reads, copied in, and the paths (or
 *  `folder/**`) whose files it wrote are copied back. */
export interface JobScope {
  read: readonly string[]
  write: readonly string[]
}

interface JobSpecBase {
  provider: JobsProvider
  name: string
  prompt: string
  /** Put before the prompt: a job's agent has no system prompt of Holi's. */
  system?: string
  model?: string
}

/** A job in a scratch folder, or in the vault under permission rules. */
type JobSpec = JobSpecBase & ({ scope: JobScope } | { allow: readonly string[] })

export type JobResult = { ok: true; sessionId: string } | { ok: false; message: string }

export interface JobsDeps {
  platform?: NodeJS.Platform
  vault: VaultRef
  /** This vault's private scratch root from `agentScratchRoots`. */
  scratchRoot: string
  onChange(list: SessionSummary[]): void
  /** Vault jobs hold sync until their physical proof is available, then join
   *  persistence of their own turn before publishing its outcome. */
  beginManagedTurn?(id: string): ManagedTurn
  /** Edge-only bracket for hosts without managed turn history. */
  bracket?(id: string, edge: 'begin' | 'end' | 'forget'): unknown | Promise<unknown>
  /** Injected children supply explicit drainage, not a native journal. */
  spawn?: NonNullable<Parameters<typeof startJobTurn>[0]['spawn']>
  ownership?: NonNullable<Parameters<typeof jobScratch>[0]['ownership']>
  /** Windows helper signal grace only; the POSIX lease owns its own grace. */
  killGraceMs?: number
  /** How long a finished job stays in the list. */
  keepMs?: number
  /** The longest a turn runs before it is stopped. */
  maxMs?: number
  log?: (msg: string) => void
  /** Revokes admission synchronously when this vault activation is invalidated. */
  activationSignal?: AbortSignal
  /** Called after the first hash check: tests inject a concurrent vault edit. */
  beforeReplace?: (rel: string) => Promise<void> | void
  /** Called after moving the old file aside: tests write through its open descriptor. */
  beforePublish?: (rel: string) => Promise<void> | void
  /** Called after each file copied back: tests stop a job mid-copy here. */
  afterWrite?: (rel: string) => Promise<void> | void
}

export interface Jobs {
  sessions(): SessionSummary[]
  has(id: string): boolean
  start(spec: JobSpec): Promise<JobResult>
  /** A follow-up to a vault job: a new turn on its thread, now or when the
   *  running one ends. Throws a `CapabilityError` when it cannot take one. */
  message(id: string, text: string): void
  stop(id: string): Promise<ActionResult>
  /** Drain every owned job and remove its state, or reject with the retained failure. */
  leave(): Promise<void>
  /** Copy back what `dir` holds inside `write`, as a job's success does:
   *  a session fenced to a folder of Holi's (`fenced.ts`) at each turn's end.
   *  `made` is what this run wrote so far, each path with the hash of what
   *  it wrote there, which it adds to. */
  copyBack(
    dir: string,
    write: readonly string[],
    made: Made,
    signal?: AbortSignal,
    deadline?: AbortSignal,
  ): Promise<{ written: number; skipped: string[] }>
}

/** What a run was given and wrote into the vault so far: each path, and the
 *  hash of the bytes it was given or wrote there. */
export type Made = Map<string, string>

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
  files: JobFiles
  turn?: ReturnType<typeof startJobTurn>
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
  /** Resolves after release, copy-back, bracket completion and owned cleanup. */
  exited: Promise<void>
  finalizationError?: Error
  secondaryPhysicalFailure?: { cause: unknown }
  dropTimer?: ReturnType<typeof setTimeout>
  retirement?: Promise<void>
}

/** A write scope entry matches a path exactly, or as `folder/**` anything
 *  under the folder.
 * @public exported for its test
 */
export function inWriteScope(rel: string, write: readonly string[]): boolean {
  return write.some((pattern) =>
    pattern.endsWith('/**') ? rel.startsWith(pattern.slice(0, -2)) : rel === pattern,
  )
}

/** Claude Code's tools that write a file, which a folder of the sandbox's can
 *  stand for. */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** Tools that only read: the sandbox reads anywhere already. */
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS'])

const RULE = /^([A-Za-z]+)(?:\((.*)\))?$/

/** The rules the Holis plugin adds to every run of a Holi (its memory and
 *  its report, `plugins/holis/main/holis.ts`): Holi's own commands, which
 *  reach Holi over the bridge, which a sandbox with no network cannot. A run
 *  goes without them; the Holi's own rules never do. */
const HOLI_RUN_RULES = new Set(
  ['remember', 'revise', 'forget', 'recall', 'search', 'report'].map(
    (verb) => `Bash(holi holis ${verb}:*)`,
  ),
)

/**
 * Claude Code permission rules as the sandbox a vault job runs in: the vault
 * folders it may write. A read is allowed, since the sandbox reads anyway; a
 * write is a folder (`Edit(tilbud/**)`), never a file, the whole vault, a
 * home path (`~/…`) or a hidden folder such as `.holi/`. The memory and
 * report rules the Holis plugin adds to a Holi's run are left out
 * (`HOLI_RUN_RULES`). Anything else, a command (Holi's own included, which
 * need the bridge the sandbox's lack of network keeps out of reach) or a web
 * tool, has no sandbox path, and the run is refused with the rule that
 * stopped it.
 * @public exported for its test
 */
export function vaultSandbox(
  allow: readonly string[],
): { ok: true; write: string[] } | { ok: false; message: string } {
  const write: string[] = []
  for (const raw of allow) {
    const rule = raw.trim()
    const m = RULE.exec(rule)
    const tool = m?.[1] ?? ''
    const arg = m?.[2]?.trim()
    if (READ_TOOLS.has(tool)) continue
    if (HOLI_RUN_RULES.has(rule)) continue
    if (tool === 'Bash' && arg !== undefined && /^holi(\s|:|$)/.test(arg)) {
      return {
        ok: false,
        message: `\`${rule}\` is a Holi command, which Codex's sandbox has no network to reach, so this run did not start. Run it on Claude Code, or leave the rule out.`,
      }
    }
    if (!WRITE_TOOLS.has(tool)) {
      return {
        ok: false,
        message: `\`${rule}\` is not a folder Codex's sandbox can allow, so this run did not start. Its sandbox allows reads and writes to named folders only.`,
      }
    }
    const path = (arg ?? '').replace(/^\.\//, '')
    if (path.startsWith('~')) {
      return {
        ok: false,
        message: `\`${rule}\` names a folder outside the vault, so this run did not start. Name one in the vault, as \`Edit(tilbud/**)\`.`,
      }
    }
    const folder = path.endsWith('/**') ? path.slice(0, -3) : null
    const rel = folder === null || folder.includes('*') ? null : readableOrNull(folder)
    if (rel === null || rel.split('/').some((segment) => segment.startsWith('.'))) {
      return {
        ok: false,
        message: `\`${rule}\` does not name a folder Codex's sandbox can make writable, so this run did not start. Name one, as \`Edit(tilbud/**)\`.`,
      }
    }
    if (!write.includes(rel)) write.push(rel)
  }
  return { ok: true, write }
}

/** The most files, and bytes in all, a job copies back. Past either it
 *  fails and copies nothing: a vault app is a page and a manifest. */
const MAX_COPY_FILES = 200
const MAX_COPY_BYTES = 20 * 1024 * 1024
/** How many left-out paths a job's message names. */
const SHOWN_SKIPPED = 10

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
export async function takenDestination(
  root: string,
  write: readonly string[],
): Promise<string | null> {
  for (const folder of newFolders(write)) {
    const there = await lstat(join(root, folder)).then(
      () => true,
      () => false,
    )
    if (there) return folder
  }
  return null
}

/**
 * Whether a job may be given a vault file to read: one no folder of it is
 * hidden. A hidden folder is where an agent looks for its own settings
 * (`.codex/config.toml` names MCP servers Codex starts, `.claude/`,
 * `.agents/`), in any case, since the disk is case-blind on macOS. Copied
 * into a run's folder, it would configure the run; and a hidden file is
 * nothing a job writes back.
 */
export const jobMayRead = (rel: string): boolean => !isHiddenPath(rel)

/**
 * Copy each of `read` from the vault at `root` into `dir`, at its vault path,
 * and note in `made` the hash of what it copied: a file the run may also
 * write is then copied back only while the vault still holds what it was
 * given. The message of the first it may not or could not read, else null.
 */
export async function copyIn(
  root: string,
  dir: string,
  read: readonly string[],
  made: Made,
): Promise<string | null> {
  for (const path of read) {
    const abs = jobMayRead(path) ? await exactPath(root, path) : null
    const data =
      abs === null
        ? null
        : await readFile(abs).then(
            async (bytes) => {
              await mkdir(dirname(join(dir, path)), { recursive: true })
              await writeFile(join(dir, path), bytes)
              return bytes
            },
            () => null,
          )
    if (data === null) return `Holi could not read ${path}.`
    made.set(path, hashOf(data))
  }
  return null
}

/** What a copy back left out, in words, or undefined when it left out
 *  nothing: a completed job's `message`, and a fenced session's. */
export const leftOutMessage = (skipped: readonly string[]): string | undefined =>
  skipped.length === 0
    ? undefined
    : `Holi left out what it may not write: ${skipped.slice(0, SHOWN_SKIPPED).join(', ')}${skipped.length > SHOWN_SKIPPED ? ` and ${skipped.length - SHOWN_SKIPPED} more` : ''}.`

/** Why a copy back stopped: something else put `rel` in the vault. */
const collision = (rel: string): string =>
  `Holi did not copy back ${rel}: something else put it in the vault while the agent worked, and Holi never writes over it.`

/** Expected cancellation, propagated only after publication cleanup/rollback succeeds. */
export class CopyBackCancelled extends Error {
  constructor() {
    super('Copy-back was cancelled.')
  }
}

/** A copy still owns preserved files or temporary state after failed cleanup. */
class CopyBackFinalizationError extends Error {}

/** Prepare the bytes off the event loop. Cleanup is owed even after cancellation. */
async function withStagedCopy(
  abs: string,
  data: Buffer,
  check: () => void,
  publish: (tmp: string) => void | Promise<void>,
): Promise<void> {
  check()
  await mkdir(dirname(abs), { recursive: true })
  check()
  const tmp = join(dirname(abs), `.holi-tmp-${randomBytes(6).toString('hex')}`)
  try {
    await writeFile(tmp, data)
    check()
    await publish(tmp)
  } finally {
    try {
      await rm(tmp, { force: true })
    } catch (err) {
      throw new CopyBackFinalizationError(`Could not clean up copy-back: ${String(err)}`)
    }
  }
}

/** Check cancellation and commit exclusively without yielding between them.
 * Only the link is synchronous here, not copying the staged bytes. */
function publishCopy(tmp: string, abs: string, rel: string, check: () => void): void {
  check()
  try {
    linkSync(tmp, abs)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(collision(rel))
    throw err
  }
}

/** Why a run did not start: where it would make something is taken. */
export const takenMessage = (folder: string): string =>
  `${folder} is already in the vault, and Holi never writes over it, so the run did not start.`

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

/** The longest follow-up queue a job keeps. */
const MAX_QUEUE = 20

export function createJobs(deps: JobsDeps): Jobs {
  if ((deps.platform ?? process.platform) === 'win32') return createWindowsJobs(deps)
  const log = deps.log ?? ((msg: string) => console.log(`[agent-jobs] ${msg}`))
  const scratch = jobScratch(deps)
  const killGraceMs = deps.killGraceMs ?? 2_000
  const keepMs = deps.keepMs ?? 10 * 60_000
  const maxMs = deps.maxMs ?? 30 * 60_000
  const jobs = new Map<string, Job>()
  let lastPushed = ''

  const summaries = (): SessionSummary[] =>
    [...jobs.values()].map((j) => ({
      id: j.id,
      provider: j.provider.id,
      name: j.name,
      state: j.busy ? 'working' : 'idle',
      startedAt: j.startedAt,
      ...(j.model === undefined ? {} : { model: j.model }),
      ...(j.tokens > 0 ? { usage: { total: j.tokens } } : {}),
      ...(j.busy || j.outcome === undefined ? {} : { outcome: j.outcome }),
      ...(j.busy || j.message === undefined
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

  function rememberFailure(
    job: Job,
    receipt: Pick<JobTurnReceipt, 'fail'>,
    error: unknown,
    phase?: 'physical',
  ): Error {
    if (job.finalizationError === undefined) {
      job.finalizationError = error instanceof Error ? error : new Error(String(error))
      try {
        receipt.fail(error)
      } catch (recordError) {
        log(`${job.id}: could not persist ownership failure: ${String(recordError)}`)
      }
    } else if (error !== job.finalizationError) {
      if (phase === 'physical') job.secondaryPhysicalFailure ??= { cause: error }
      log(`${job.id}: additional finalization failure: ${String(error)}`)
    }
    return job.finalizationError
  }

  function requestStop(job: Job, why: string): void {
    job.stopped ??= why
    job.queue = []
    job.copyController?.abort()
    job.turn?.stop()
  }

  async function kill(job: Job, why: string): Promise<void> {
    if (!job.busy) {
      if (job.finalizationError !== undefined) throw job.finalizationError
      return
    }
    requestStop(job, why)
    // Stop joins the natural owner's deadline, which only starts after drain.
    await job.exited
  }

  /** Move the current file aside atomically, then publish the replacement
   * only if the name remains free. The moved file is checked before publishing:
   * a sync write arriving after the caller's hash check is never replaced.
   * A competing file arriving while the name is free wins as well. */
  async function replaceKnown(
    abs: string,
    rel: VaultRelPath,
    tmp: string,
    before: string,
    check: () => void,
  ) {
    const hold = await mkdtemp(join(dirname(abs), '.holi-copy-'))
    const previous = join(hold, 'previous')
    let moved = false
    let keep = false
    try {
      check()
      renameSync(abs, previous)
      moved = true
      const old = await readRegular(previous)
      if (old === null || hashOf(old) !== before) throw new Error(collision(rel))
      check()
      await deps.beforePublish?.(rel)
      check()
      // Check an open descriptor's write before publishing the replacement.
      // A write after this check is the residual race the vault accepts.
      const after = await readRegular(previous)
      if (after === null || hashOf(after) !== before) throw new Error(collision(rel))
      publishCopy(tmp, abs, rel, check)
    } catch (err) {
      if (moved) {
        try {
          // Rollback remains owed after the deadline. Never replace a new file.
          await link(previous, abs)
        } catch (restore) {
          keep = true
          const failure =
            (restore as NodeJS.ErrnoException).code === 'EEXIST'
              ? ''
              : ` Restoration failed: ${String(restore)}.`
          throw new CopyBackFinalizationError(
            `${String(err)}${failure} The previous file is preserved at ${relative(deps.vault.root, previous)}.`,
            { cause: err },
          )
        }
      }
      throw err
    } finally {
      // A committed replacement or successful rollback no longer needs the hold.
      // In particular, a deadline during cleanup cannot undo a committed link.
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
    deadline?: AbortSignal,
  ): Promise<{ written: number; skipped: string[] }> {
    const stopped = (): boolean =>
      job.stopped !== undefined || job.signal?.aborted === true || deadline?.aborted === true
    const check = (): void => {
      deadline?.throwIfAborted()
      if (stopped()) throw new CopyBackCancelled()
    }
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
        await withStagedCopy(abs, data, check, (tmp) => publishCopy(tmp, abs, rel, check))
      } else {
        // What this run was given or wrote before: written over only while
        // the vault still holds exactly that, read again just before.
        const now = await readRegular(abs)
        if (now === null || hashOf(now) !== before) {
          throw new Error(
            `Holi did not copy back what the agent wrote: ${rel} changed in the vault since the agent wrote it, and Holi never writes over it.`,
          )
        }
        deadline?.throwIfAborted()
        await deps.beforeReplace?.(rel)
        if (stopped()) break
        await withStagedCopy(abs, data, check, (tmp) => replaceKnown(abs, rel, tmp, before, check))
      }
      made.set(rel, hash)
      written += 1
      deadline?.throwIfAborted()
      await deps.afterWrite?.(rel)
    }
    return { written, skipped }
  }

  /** The job leaves the list, and its agent's state goes with it. */
  async function drop(job: Job): Promise<void> {
    // Revoke admission before the first asynchronous filesystem operation.
    job.retiring = true
    job.queue = []
    clearTimeout(job.dropTimer)
    if (job.finalizationError !== undefined) throw job.finalizationError
    if (job.retirement === undefined) {
      const label = `Cleanup of job ${job.id}`
      const timeoutMs = 5_000
      const deadline = performance.now() + timeoutMs
      const controller = new AbortController()
      const check = () => {
        controller.signal.throwIfAborted()
        if (performance.now() >= deadline)
          throw new Error(`${label} did not finish before teardown timed out.`)
      }
      const retirement = (async () => {
        await job.exited
        check()
        await rm(job.state, { recursive: true, force: true })
        check()
        await job.files.retire(check)
        check()
        if (jobs.get(job.id) === job) jobs.delete(job.id)
        push()
      })()
      // One deadline and one terminal result for the owner, including TTL.
      // A filesystem operation already in flight may finish, but not advance.
      job.retirement = bounded(retirement, label, timeoutMs).catch((error: unknown) => {
        controller.abort(error)
        const failure = rememberFailure(job, job.files, error)
        job.outcome = 'failed'
        job.message = failure.message
        push()
        throw failure
      })
    }
    await job.retirement
  }

  function runTurn(
    job: Job,
    run: JobRun,
    write: readonly string[],
  ): { ok: true } | { ok: false; message: string } {
    const { id, provider } = job
    const receipt = job.files.turn()
    job.busy = true
    delete job.stopped
    clearTimeout(job.dropTimer)
    let physicalFailed = false
    const fail = (error: unknown, phase?: 'physical') => {
      if (phase === 'physical') physicalFailed = true
      return rememberFailure(job, receipt, error, phase)
    }
    const tooLong = setTimeout(() => {
      void kill(job, 'The job ran too long and was stopped.').catch((error: unknown) =>
        log(`${id}: could not stop: ${String(error)}`),
      )
    }, maxMs)
    tooLong.unref?.()

    // Stop can re-enter from the spawn adapter. Publish the new settlement
    // before invoking it, even though the lease is not yet available to stop.
    let resolveExited!: () => void
    let rejectExited!: (error: unknown) => void
    job.exited = new Promise<void>((resolve, reject) => {
      resolveExited = resolve
      rejectExited = reject
    })
    void job.exited.catch(() => {})
    const began = generation
    const turn = startJobTurn({
      id,
      provider,
      run,
      receipt,
      killGraceMs,
      ...(deps.spawn && { spawn: deps.spawn }),
      rememberFailure: fail,
      onDraining: () => clearTimeout(tooLong),
      progress(event) {
        if (event.kind === 'thread') {
          job.thread ??= event.id
          log(`${id}: thread ${event.id}`)
        } else if (event.tokens !== undefined) {
          job.tokens = event.tokens
          push()
        }
      },
    })
    job.turn = turn
    // No await or publication may intervene between registering the lease
    // and honoring a Stop or activation revocation while it was being made.
    const revoked = closing || generation !== began || deps.activationSignal?.aborted === true
    const posix = process.platform !== 'win32'
    if (posix && (revoked || job.stopped !== undefined)) requestStop(job, 'Stopped.')
    // The session host already closed admission on revocation. Do not try to
    // claim a new bracket there; the retained lease still owes physical proof.
    const bracket = turn.bracket && job.place !== null && !(posix && revoked)
    let managed: ManagedTurn | undefined
    if (bracket && deps.beginManagedTurn !== undefined) {
      try {
        managed = deps.beginManagedTurn(id)
      } catch (error) {
        fail(error)
      }
    }
    const legacyBracket = bracket && deps.beginManagedTurn === undefined
    const bracketBegin = legacyBracket
      ? Promise.resolve()
          .then(() => deps.bracket?.(id, 'begin'))
          .catch(fail)
      : undefined
    void (async () => {
      let safeToForget = false
      try {
        const output = await turn.output.catch((error: unknown) => {
          // A bracketed POSIX turn has a lease. Its output only rejects after
          // joining that lease; physical failure is reported separately, even
          // if a broken pipe was the first error. Don't infer it from `error`.
          safeToForget = process.platform !== 'win32' && bracket && !physicalFailed
          throw error
        })
        safeToForget = true
        clearTimeout(tooLong)
        const controller = new AbortController()
        const { signal } = controller
        job.finalizing = true
        const finish = async () => {
          await bracketBegin
          signal.throwIfAborted()
          // Physical/output failure never reaches release.
          try {
            await provider.release?.(job.state, signal)
          } catch (error) {
            fail(error)
            signal.throwIfAborted()
          }
          signal.throwIfAborted()
          let outcome: 'completed' | 'failed' = 'failed'
          let why = job.finalizationError?.message ?? job.stopped ?? output.refusal
          if (why === undefined && output.completed) {
            outcome = 'completed'
            if (job.dir !== null) {
              try {
                job.copyController = new AbortController()
                const { written, skipped } = await copyBack(
                  { ...job, signal: job.copyController.signal },
                  job.dir,
                  write,
                  job.made,
                  signal,
                )
                signal.throwIfAborted()
                log(`${id}: done, ${written} file(s) written, ${skipped.length} left out`)
                why = leftOutMessage(skipped)
              } catch (error) {
                if (error instanceof CopyBackFinalizationError) fail(error)
                signal.throwIfAborted()
                outcome = 'failed'
                why = error instanceof Error ? error.message : String(error)
              }
            } else log(`${id}: turn done`)
          } else {
            why ??= output.failure
            log(`${id}: failed: ${why}`)
          }
          if (legacyBracket) {
            try {
              await deps.bracket?.(id, 'end')
            } catch (error) {
              fail(error)
              signal.throwIfAborted()
            }
          }
          signal.throwIfAborted()
          if (job.dir !== null && job.finalizationError === undefined) {
            await rm(job.dir, { recursive: true, force: true })
            signal.throwIfAborted()
            await rm(job.state, { recursive: true, force: true })
          }
          signal.throwIfAborted()
          if (managed !== undefined && job.finalizationError === undefined && !receipt.didNotLaunch)
            await managed.end(signal)
          signal.throwIfAborted()
          return { outcome, why }
        }
        try {
          const { outcome, why } = await bounded(finish(), `Finalization of job ${id}`)
          // Persist caller settlement and clear a scoped job's diagnostic PID
          // before making its outcome visible. The link follows row retirement.
          if (job.finalizationError === undefined) receipt.settle(job.dir !== null)
          job.outcome = job.stopped === undefined ? outcome : 'failed'
          job.message = job.finalizationError?.message ?? job.stopped ?? why
        } catch (error) {
          controller.abort(fail(error))
        }
      } catch (error) {
        fail(error)
      } finally {
        if (managed !== undefined && safeToForget) {
          // No-op if end already consumed the bracket. Otherwise we proved
          // non-admission or abandoned settlement after physical proof.
          try {
            managed.forget()
          } catch (error) {
            fail(error)
          }
        }
        clearTimeout(tooLong)
        job.turn = undefined
        job.copyController = undefined
        job.finalizing = false
        job.busy = false
        if (job.finalizationError !== undefined || job.stopped !== undefined) {
          job.outcome = 'failed'
          job.message = job.finalizationError?.message ?? job.stopped
        }
        if (job.finalizationError !== undefined || turn.refusal !== undefined) job.queue = []
        scheduleDrop(job)
        push()
      }
      if (job.finalizationError !== undefined) throw job.finalizationError
      followUp(job)
    })().then(resolveExited, rejectExited)
    if (turn.refusal !== undefined) return { ok: false, message: turn.refusal }
    push()
    return { ok: true }
  }

  function scheduleDrop(job: Job): void {
    if (job.finalizationError !== undefined || job.retiring) return
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
      job.retiring ||
      job.stopped !== undefined ||
      job.finalizationError !== undefined ||
      place === null ||
      job.thread === undefined ||
      job.queue.length === 0
    )
      return
    delete job.stopped
    job.busy = true
    const text = job.queue.join('\n\n')
    job.queue = []
    runTurn(
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

  const sweeping = scratch.recover().catch((error: unknown) => {
    log(`Could not recover job state: ${String(error)}`)
    throw error
  })
  const swept = bounded(sweeping, 'Agent job state sweep')
  void swept.catch(() => {})

  /** Leaving the vault bumps it: a start that began before sees it changed
   *  and spawns nothing. */
  let generation = 0
  let closing = deps.activationSignal?.aborted === true
  /** Starts getting ready (folders, copies): `leave` waits for them. */
  const starting = new Set<Promise<JobResult>>()
  deps.activationSignal?.addEventListener(
    'abort',
    () => {
      closing = true
      generation += 1
      for (const job of jobs.values()) {
        job.queue = []
        const pending = kill(job, 'Stopped.')
        void pending.catch((err: unknown) => log(`${job.id}: could not stop: ${String(err)}`))
      }
    },
    { once: true },
  )

  async function finishRefusal(job: Job, message: string): Promise<JobResult> {
    job.retiring = true
    try {
      job.turn?.stop()
      await job.exited
      await drop(job)
    } catch (err) {
      return { ok: false, message: `${message} Could not finalize job: ${String(err)}` }
    }
    return { ok: false, message }
  }

  /** A job's start, up to its first turn's spawn. Between its awaits the
   *  vault may be left; it then stops there, before anything runs. */
  async function begin(spec: JobSpec): Promise<JobResult> {
    const { provider, name, prompt, system, model } = spec
    if (closing) return { ok: false, message: 'The vault is closing.' }
    const began = generation
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
      files: scratch.forJob(id),
      busy: false,
      queue: [],
      tokens: 0,
      exited: Promise.resolve(),
    }

    try {
      await swept
    } catch (err) {
      return { ok: false, message: `Could not sweep agent job state: ${String(err)}` }
    }
    // Left while it got ready: it never spawns against the closed vault.
    const left = (): boolean => generation !== began
    const gone = 'The vault was left before the job started.'
    if (left()) return { ok: false, message: gone }
    await mkdir(job.state, { recursive: true, mode: 0o700 })
    if ('allow' in spec) {
      const sandbox = vaultSandbox(spec.allow)
      if (!sandbox.ok) {
        await rm(job.state, { recursive: true, force: true }).catch(() => undefined)
        return sandbox
      }
      const place = left() ? gone : await placeIn(sandbox.write)
      if (typeof place === 'string' || left()) {
        await rm(job.state, { recursive: true, force: true }).catch(() => undefined)
        return { ok: false, message: typeof place === 'string' ? place : gone }
      }
      job.place = place
      // The agent runs in a folder of the vault, or reads it all: every
      // path it is given is the vault's.
      const where = `The vault is ${deps.vault.root}. Every vault path named here is relative to it.`
      jobs.set(id, job)
      const started = runTurn(
        job,
        {
          cwd: place.cwd,
          root: deps.vault.root,
          prompt: [system, where, prompt].filter((p) => p !== undefined).join('\n\n'),
          writable: place.writable,
          readOnly: place.readOnly,
          state: job.state,
          ...(model === undefined ? {} : { model }),
        },
        [],
      )
      if (!started.ok) return finishRefusal(job, started.message)
      return { ok: true, sessionId: id }
    }

    const { scope } = spec
    const dir = join(deps.scratchRoot, id)
    const fail = async (message: string): Promise<JobResult> => {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      await rm(job.state, { recursive: true, force: true }).catch(() => undefined)
      return { ok: false, message }
    }
    const taken = await takenDestination(deps.vault.root, scope.write)
    if (taken !== null) return fail(takenMessage(taken))
    await mkdir(dir, { recursive: true })
    const unread = await copyIn(deps.vault.root, dir, scope.read, job.made)
    if (unread !== null) return fail(unread)
    if (left()) return fail(gone)
    job.dir = dir
    jobs.set(id, job)
    const started = runTurn(
      job,
      {
        cwd: dir,
        root: deps.vault.root,
        prompt: system === undefined ? prompt : `${system}\n\n${prompt}`,
        state: job.state,
        ...(model === undefined ? {} : { model }),
      },
      scope.write,
    )
    if (!started.ok) return finishRefusal(job, started.message)
    return { ok: true, sessionId: id }
  }

  let leaving: Promise<void> | undefined
  let rootRetirement: Promise<void> | undefined
  let drained = false

  async function leave(): Promise<void> {
    closing = true
    generation += 1
    const stopRegistered = () => {
      const all = [...jobs.values()]
      for (const job of all) {
        job.retiring = true
        job.queue = []
        clearTimeout(job.dropTimer)
      }
      // Close installed leases before awaiting anything. In-flight registration
      // already has a settlement promise, and will close its lease on return.
      const results = Promise.allSettled(all.map((job) => kill(job, 'Stopped.')))
      return { all, results }
    }
    let sweepFailure: { reason: unknown } | undefined
    const joinSweep = () => bounded(sweeping, 'Agent job state sweep')
    // Keep the compatibility path's sweep-before-signalling order on Windows.
    if (process.platform === 'win32') await joinSweep()
    const { all, results } = stopRegistered()
    // The startup deadline may have expired while the actual sweep or a start
    // is still mutating disk. Neither can outlive a successful teardown.
    if (process.platform !== 'win32') {
      try {
        await joinSweep()
      } catch (reason) {
        sweepFailure = { reason }
      }
    }
    const failures = (await results).flatMap((result, i) => {
      if (result.status !== 'rejected') return []
      const secondary = all[i]?.secondaryPhysicalFailure
      return secondary ? [result.reason, secondary.cause] : [result.reason]
    })
    if (sweepFailure !== undefined) {
      if (failures.length === 0) throw sweepFailure.reason
      failures.unshift(sweepFailure.reason)
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more agent jobs did not drain.')
    }
    // A refused start may still be joining a native launch cancellation. Its
    // job was already published and drained above; pending pre-spawn starts
    // cannot publish after admission closes.
    await bounded(Promise.all([...starting]), 'Agent job starts')
    await Promise.all(all.map((job) => drop(job)))
    if (rootRetirement === undefined) {
      const retirement = rm(deps.scratchRoot, { recursive: true, force: true })
      rootRetirement = retirement
      void retirement.catch(() => {
        if (rootRetirement === retirement) rootRetirement = undefined
      })
    }
    await bounded(rootRetirement, 'Agent job root cleanup')
    drained = true
    push()
  }

  return {
    sessions: summaries,
    has: (id) => jobs.has(id),

    async start(spec) {
      if (closing) return { ok: false, message: 'The vault is closing.' }
      const begun = begin(spec)
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
        clearTimeout(job.dropTimer)
        await drop(job)
        push()
      }
      return { ok: true }
    },

    async leave() {
      if (drained) return
      if (leaving === undefined) {
        leaving = leave().finally(() => {
          leaving = undefined
        })
      }
      await leaving
    },

    copyBack: (dir, write, made, signal, deadline) =>
      copyBack({ signal }, dir, write, made, deadline),
  }
}
