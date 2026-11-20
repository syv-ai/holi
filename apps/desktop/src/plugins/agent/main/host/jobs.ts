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
 * and handles parent death through control EOF. The PID file is evidence for
 * restart, never signal authority. Recovery only removes proven absent runs.
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
import { execFileSync, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants, rmSync } from 'node:fs'
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { createInterface } from 'node:readline'
import { isHiddenPath, isSharedContentPath, vaultRelPath, type VaultRelPath } from '@holi/shared'
import { exactPath } from '@holi/shared/path-safety-node'
import {
  CapabilityError,
  readableOrNull,
  spawnOwnedProgram,
  ownedProcessDrain,
  type ProcessGroupSupervision,
} from '../../../../main/plugin-api'
import type { SessionSummary } from '../claude/listing'
import type { JobRun, JobsProvider, VaultRef } from '../provider'
import { bounded } from './bounded'
import type { ActionResult } from './sessions'

/**
 * Holi's id for a job: never a background job id or a PTY session's.
 * @public exported for its test
 */
export const JOB_SESSION_ID = /^j[0-9a-f]{12}$/

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

type JobChild = ChildProcess & { [ownedProcessDrain]?: ProcessGroupSupervision }

/** How a job's process starts. An injected POSIX child must supply its own drain. */
type SpawnJob = (
  bin: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string> },
) => JobChild

/** A retained POSIX group lease or the dedicated Windows Job Object helper. */
const defaultSpawnJob: SpawnJob = (bin, args, { cwd, env }) =>
  spawnOwnedProgram(bin, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    posixGroupLease: true,
  })

export interface JobsDeps {
  vault: VaultRef
  /** This vault's private scratch root from `agentScratchRoots`. */
  scratchRoot: string
  onChange(list: SessionSummary[]): void
  /** The vault's turn bracket, for a job in the vault: sync pauses and the
   *  turn is recorded. */
  bracket?(id: string, edge: 'begin' | 'end' | 'forget'): unknown | Promise<unknown>
  spawn?: SpawnJob
  /** Read-only restart proof. An injected spawn never probes the real OS. */
  recoveryAbsent?: (pidOrGroup: number) => boolean
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
  child: ChildProcess | null
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
  requestDrain?: () => Promise<void>
  stopWait?: Promise<void>
  pidWrite?: Promise<void>
  finalizationError?: Error
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

/** Process-table diagnostic, not ownership or absence proof.
 * @public exported for its test */
export const defaultCommandOf = (
  pid: number,
  platform: NodeJS.Platform = process.platform,
): string | null => {
  if (!Number.isInteger(pid) || pid <= 1) return null
  try {
    const [file, args] =
      platform === 'win32'
        ? [
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
            ],
          ]
        : ['ps', ['-o', 'args=', '-p', String(pid)]]
    return execFileSync(file as string, args as string[], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 10_000,
    }).trim()
  } catch {
    return null
  }
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

// A positively unlaunched follow-up has no PID, but its private state remains
// resumable until retention. Only this exact record exempts it from PID probing.
const UNLAUNCHED_FOLLOWUP = 'settled: unlaunched follow-up\n'

/** Signal zero is a read-only kernel check. Permission and probe errors do not prove absence. */
function kernelAbsent(pidOrGroup: number): boolean {
  try {
    process.kill(pidOrGroup, 0)
    return false
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

export function createJobs(deps: JobsDeps): Jobs {
  const log = deps.log ?? ((msg: string) => console.log(`[agent-jobs] ${msg}`))
  const spawnJob = deps.spawn ?? defaultSpawnJob
  const recoveryAbsent = deps.recoveryAbsent ?? (deps.spawn ? () => false : kernelAbsent)
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

  function rememberFailure(job: Job, err: unknown): Error {
    return (job.finalizationError ??= err instanceof Error ? err : new Error(String(err)))
  }

  function signalWindows(child: ChildProcess, sig: 'SIGTERM' | 'SIGKILL'): void {
    // This is the dedicated Job Object helper's control channel, not a PID signal.
    if (child.pid === undefined) return
    try {
      child.kill(sig)
    } catch {
      // The helper's close or the bounded wait reports the result.
    }
  }

  function waitForExit(job: Job): Promise<void> {
    return (job.stopWait ??= (async () => {
      const physical = job.requestDrain?.()
      if (physical !== undefined) await physical
      // No output or provider timer can replace the lease's own deadline.
      await bounded(
        job.exited,
        `Output and finalization of job ${job.id}`,
        physical === undefined && process.platform === 'win32' ? killGraceMs + 5_000 : 5_000,
      )
    })().catch((error: unknown) => {
      throw rememberFailure(job, error)
    }))
  }

  async function kill(job: Job, why: string): Promise<void> {
    if (!job.busy) {
      if (job.finalizationError !== undefined) throw job.finalizationError
      return
    }
    // Set first: a copy back under way reads it, after the process is gone.
    job.stopped ??= why
    job.queue = []
    job.copyController?.abort()
    const child = job.child
    let timer: ReturnType<typeof setTimeout> | undefined
    if (job.requestDrain === undefined && child !== null && process.platform === 'win32') {
      signalWindows(child, 'SIGTERM')
      timer = setTimeout(() => {
        if (job.child === child) signalWindows(child, 'SIGKILL')
      }, killGraceMs)
    }
    try {
      await waitForExit(job)
    } finally {
      clearTimeout(timer)
    }
  }

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
  async function drop(job: Job): Promise<void> {
    // Revoke admission before the first asynchronous filesystem operation.
    job.retiring = true
    job.queue = []
    clearTimeout(job.dropTimer)
    if (job.finalizationError !== undefined) throw job.finalizationError
    if (job.retirement === undefined) {
      const retirement = (async () => {
        await job.exited
        if (job.finalizationError !== undefined) throw job.finalizationError
        await job.pidWrite
        await rm(job.state, { recursive: true, force: true })
        await rm(pidFile(job.id), { force: true })
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
    await bounded(job.retirement, `Cleanup of job ${job.id}`)
  }

  /** One turn owns its launch, output and finalization until they settle. */
  function runTurn(
    job: Job,
    run: JobRun,
    write: readonly string[],
  ): { ok: true } | { ok: false; message: string } {
    const { id, provider } = job
    let child: JobChild | undefined
    let refused: string | undefined
    let launchCleanup: Promise<void> | undefined
    let spawnAttempted = false
    let launchError: unknown
    const followup = run.resume !== undefined && process.platform !== 'win32'
    try {
      const command = provider.capabilities.jobs.command(run)
      if (command === null) refused = provider.notInstalled
      else {
        try {
          // A vault job keeps its settled receipt for restart while idle.
          // Invalidate that old evidence before a new child could exist.
          if (job.place !== null) rmSync(pidFile(id), { force: true })
          spawnAttempted = true
          child = spawnJob(command.bin, command.args, { cwd: run.cwd, env: command.env })
        } catch (err) {
          launchError = err
          refused = `${provider.label} did not start: ${err instanceof Error ? err.message : String(err)}`
          // Native synchronous spawn failure can still own launch cancellation.
          const receipt = err as { cleanup?: Promise<void>; cleanupPromise?: Promise<void> } | null
          launchCleanup = receipt?.cleanup ?? receipt?.cleanupPromise
        }
      }
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err)
    }
    let resolveExited!: () => void
    let rejectExited!: (err: Error) => void
    job.exited = new Promise<void>((resolve, reject) => {
      resolveExited = resolve
      rejectExited = reject
    })
    void job.exited.catch(() => {})
    job.stopWait = undefined
    job.child = child ?? null
    job.busy = true
    delete job.stopped
    job.pidWrite = undefined
    clearTimeout(job.dropTimer)
    if (child?.pid !== undefined) {
      const line = `${child.pid}\n${run.cwd}\n`
      job.pidWrite = mkdir(deps.scratchRoot, { recursive: true }).then(() =>
        writeFile(pidFile(id), line),
      )
      void job.pidWrite.catch((err: unknown) => {
        rememberFailure(job, err)
      })
    }
    const group = child?.[ownedProcessDrain]
    const missingLease = child !== undefined && group === undefined && process.platform !== 'win32'
    const bracket = child !== undefined && job.place !== null && !missingLease
    const bracketBegin = bracket
      ? Promise.resolve()
          .then(() => deps.bracket?.(id, 'begin'))
          .catch((err: unknown) => {
            rememberFailure(job, err)
          })
      : undefined

    let completed = false
    let failure: string | undefined
    let eventError: string | undefined
    let childError: string | undefined
    let unlaunchedFollowup = false
    let stderr = ''
    if (child?.stdout != null) {
      createInterface({ input: child.stdout }).on('line', (line) => {
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
        else if (event.kind === 'error') eventError = event.message
      })
    }
    child?.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4_000)
    })
    const tooLong = setTimeout(() => {
      void kill(job, 'The job ran too long and was stopped.').catch((err: unknown) =>
        log(`${id}: could not stop: ${String(err)}`),
      )
    }, maxMs)
    tooLong.unref?.()

    let settled = false
    function complete() {
      if (settled) return
      settled = true
      clearTimeout(tooLong)
      job.requestDrain = undefined
      job.copyController = undefined
      job.finalizing = false
      job.busy = false
      if (job.finalizationError !== undefined) {
        job.queue = []
        job.outcome = 'failed'
        job.message = job.finalizationError.message
        rejectExited(job.finalizationError)
      } else {
        if (job.stopped !== undefined) {
          job.outcome = 'failed'
          job.message = job.stopped
        }
        resolveExited()
        scheduleDrop(job)
      }
      push()
      if (refused === undefined) followUp(job)
      else job.queue = []
    }
    let physical: Promise<void> | undefined
    function drain(): Promise<void> {
      if (physical === undefined) {
        // An async call also captures a synchronous throw from the supervisor.
        physical = (async () => {
          if (group !== undefined) await group.drain()
          else await launchCleanup
        })()
        // Fail independently of output: an inherited pipe may never close
        // after failed teardown. Nothing below releases or deletes its state.
        void physical.catch((err: unknown) => {
          rememberFailure(job, err)
          complete()
        })
      }
      return physical
    }
    job.requestDrain = group !== undefined || launchCleanup !== undefined ? drain : undefined

    let finalizing = false
    function settle(code: number | null, sig: NodeJS.Signals | null): void {
      if (finalizing || settled) return
      finalizing = true
      clearTimeout(tooLong)
      void finalize(code, sig).then(complete, (err: unknown) => {
        rememberFailure(job, err)
        complete()
      })
    }

    async function finalize(code: number | null, sig: NodeJS.Signals | null): Promise<void> {
      await drain()
      if (followup && spawnAttempted && job.pidWrite === undefined && !unlaunchedFollowup) {
        // A synchronous throw can happen after fork. Join its cleanup first,
        // but never replace missing launch evidence with a settled record.
        throw launchError ?? new Error(childError ?? `Unresolved owner of job ${id}.`)
      }
      job.child = null
      await bracketBegin
      try {
        await provider.release?.(job.state)
      } catch (err) {
        rememberFailure(job, err)
      }
      if (unlaunchedFollowup && job.finalizationError === undefined) {
        await writeFile(pidFile(id), UNLAUNCHED_FOLLOWUP, { flag: 'wx', mode: 0o600, flush: true })
        const dir = await open(deps.scratchRoot, constants.O_RDONLY | constants.O_DIRECTORY)
        try {
          await dir.sync()
        } finally {
          await dir.close()
        }
      }
      let outcome: 'completed' | 'failed' = 'failed'
      let why = job.finalizationError?.message ?? job.stopped ?? refused ?? childError
      if (why === undefined && completed && failure === undefined && code === 0) {
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
            why = leftOutMessage(skipped)
          } catch (err) {
            outcome = 'failed'
            why = err instanceof Error ? err.message : String(err)
            if (err instanceof CopyBackFinalizationError) rememberFailure(job, err)
          }
        } else log(`${id}: turn done`)
      } else {
        why ??=
          failure ??
          eventError ??
          (sig !== null
            ? `${provider.label} was stopped (${sig}).`
            : `${provider.label} exited with code ${code ?? '?'}${lastLine(stderr) === '' ? '.' : `: ${lastLine(stderr)}`}`)
        log(`${id}: failed: ${why}`)
      }
      job.outcome = job.stopped === undefined ? outcome : 'failed'
      job.message = job.finalizationError?.message ?? job.stopped ?? why
      if (job.dir !== null && job.finalizationError === undefined) {
        await job.pidWrite
        // Keep the receipt until the owned folders have actually been removed.
        const results = await Promise.allSettled([
          rm(job.dir, { recursive: true, force: true }),
          rm(job.state, { recursive: true, force: true }),
        ])
        for (const result of results) {
          if (result.status === 'rejected') rememberFailure(job, result.reason)
        }
      }
      job.finalizing = true
      push()
      // The outcome is on the row before the bracket's end is told. The
      // turn remains owned through persistence and the remaining cleanup.
      if (bracket) {
        try {
          await deps.bracket?.(id, 'end')
        } catch (err) {
          rememberFailure(job, err)
        }
      }
      await job.pidWrite
      if (job.dir !== null && job.finalizationError === undefined) {
        await rm(pidFile(id), { force: true })
      }
    }

    if (child === undefined) {
      settle(null, null)
      return { ok: false, message: refused! }
    }
    // Node gives a PID even during the lease's pre-exec setup. Treat that
    // conservatively as possibly started, even before the spawn event.
    let started = child.pid !== undefined
    child.once('spawn', () => {
      started = true
    })
    child.once('exit', () => {
      if (settled) return
      started = true
      job.requestDrain?.()
    })
    child.once('close', settle)
    child.on('error', (err) => {
      if (settled || finalizing) return
      if (started || child.pid !== undefined) {
        childError ??= `${provider.label} process error: ${err.message}`
        job.requestDrain?.()
      } else {
        childError ??= `${provider.label} did not start: ${err.message}`
        // The native POSIX adapter classifies no-PID ENOENT as unlaunched.
        // The record is only written after that adapter's cancellation settles.
        unlaunchedFollowup =
          followup &&
          deps.spawn === undefined &&
          group !== undefined &&
          (err as NodeJS.ErrnoException).code === 'ENOENT'
        launchError = err
        settle(null, null)
      }
    })
    if (missingLease) {
      // The adapter already returned a child; keep its owner rather than
      // treating this contract violation as an ordinary spawn refusal.
      const error = new Error(`Job ${id} has no POSIX launch lease; its owner is unresolved.`)
      rememberFailure(job, error)
      complete()
      return { ok: false, message: error.message }
    }
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

  // Resolve the whole private namespace before deleting anything. A receipt
  // can describe a recycled PID or a leaderless group; neither is ours to
  // signal. Missing evidence can also mean a crash before the PID was written.
  async function sweep(): Promise<void> {
    const root = await lstat(deps.scratchRoot).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    })
    if (root !== null && !root.isDirectory())
      throw new Error(`Not a job state directory: ${deps.scratchRoot}`)
    const names = await readdir(deps.scratchRoot).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    })
    if (names === null) return
    const ids = new Set<string>()
    for (const name of names) {
      const id = name.replace(/\.(pid|agent)$/, '')
      if (!JOB_SESSION_ID.test(id)) throw new Error(`Unresolved job state: ${name}.`)
      ids.add(id)
    }
    for (const id of ids) {
      const receipt = names.includes(`${id}.pid`) ? await readRegular(pidFile(id)) : null
      const text = receipt?.toString('utf8') ?? ''
      if (process.platform !== 'win32' && text === UNLAUNCHED_FOLLOWUP) continue
      // A partial write of a numeric prefix is not evidence for that PID.
      const pid = Number(/^([1-9]\d{0,9})\n[\s\S]+\n$/.exec(text)?.[1])
      if (!Number.isInteger(pid) || pid <= 1 || pid > 0x7fffffff) {
        throw new Error(`Unresolved owner of job ${id}: no valid PID receipt.`)
      }
      if (!recoveryAbsent(pid) || (process.platform !== 'win32' && !recoveryAbsent(-pid))) {
        throw new Error(
          `Unresolved owner of job ${id}: PID ${pid} or its group is not proven absent.`,
        )
      }
    }
    await rm(deps.scratchRoot, { recursive: true, force: true })
  }
  const sweeping = sweep()
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
      await waitForExit(job)
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
      child: null,
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
      await rm(pidFile(id), { force: true }).catch(() => undefined)
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
    // The startup deadline may have expired while the actual sweep or a start
    // is still mutating disk. Neither can outlive a successful teardown.
    await bounded(sweeping, 'Agent job state sweep')
    const all = [...jobs.values()]
    for (const job of all) {
      job.retiring = true
      job.queue = []
      clearTimeout(job.dropTimer)
    }
    const results = await Promise.allSettled(all.map((job) => kill(job, 'Stopped.')))
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    )
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

    copyBack: (dir, write, made, signal) => copyBack({ signal }, dir, write, made),
  }
}
