/**
 * Jobs: a prompt run with nobody watching, for a provider with no supervisor
 * of its own but a way to run unattended (`jobs`, Codex's `codex exec`).
 * docs/features/agent-sessions.md, Jobs.
 *
 * **Two places a job runs**, each sandboxed by the agent's own rules:
 *
 * - **A scratch folder** (`scope`, a document's agent): Holi makes one of its
 *   own (`<userData>/agent-jobs/<id>/`), copies in the files the job may
 *   read, at their vault paths, and runs the agent there. What bounds it is
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
 * Either way, what a turn's process left running in its group is killed when
 * it exits. Beside the scratch folders is `<id>.pid`, the running turn's pid
 * and the folder it runs in, outside what any job may write: a crash leaves
 * it behind, and the next start kills that group (when it still leads one and
 * its command names that folder) before the folders go.
 *
 * **It is a session in the one list**, named by Holi's id (`j` and twelve hex
 * digits): working while a turn runs, then idle with its `outcome` (and why,
 * when it failed) for a while, so whoever started it reads the result off the
 * row: `completed` or `failed`, as a Pi run's, why it failed as its `error`.
 * What its turns used is its `usage.total`, when the agent says.
 *
 * **A follow-up** (`message`) to a vault job is a new turn on the agent's
 * thread (`resume`): queued while a turn runs, sent when it ends. The agent
 * has no way to take a message mid-turn from Holi.
 *
 * The process leads its own group and is stopped by group, after asking what
 * the pid is right now, as the PTY's kill path does (`pty.ts`).
 *
 * NOTE: no `electron` import, so this loads under vitest.
 */
import { execFileSync, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
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
  defaultProbePid,
  killChildTree,
  killTree,
  readableOrNull,
  spawnOwnedProgram,
  type PidState,
} from '../../../../main/plugin-api'
import type { SessionSummary } from '../claude/listing'
import type { JobRun, JobsProvider, VaultRef } from '../provider'
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

/** How a job's process starts. Tests run small scripts through it. */
type SpawnJob = (
  bin: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string> },
) => ChildProcess

/** Its own group, so a stop reaches what it started too. (On Windows the
 *  child is not detached, which would only open a console window for what it
 *  starts; `killTree` stops its tree by the root pid.) */
const defaultSpawnJob: SpawnJob = (bin, args, { cwd, env }) =>
  spawnOwnedProgram(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })

export interface JobsDeps {
  vault: VaultRef
  /** Where the scratch folders go: `<userData>/agent-jobs`. */
  scratchRoot: string
  onChange(list: SessionSummary[]): void
  /** The vault's turn bracket, for a job in the vault: sync pauses and the
   *  turn is recorded. */
  bracket?(id: string, edge: 'begin' | 'end' | 'forget'): void
  spawn?: SpawnJob
  probePid?: (pid: number) => PidState
  /** A live process's command line, or null: the sweep's check that a pid
   *  left behind is still a job's. */
  commandOf?: (pid: number) => string | null
  /** SIGTERM, then this long, then SIGKILL. */
  killGraceMs?: number
  /** How long a finished job stays in the list. */
  keepMs?: number
  /** The longest a turn runs before it is stopped. */
  maxMs?: number
  log?: (msg: string) => void
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
  /** Stop every job and delete every scratch folder. */
  leave(): Promise<void>
  /** Copy back what `dir` holds inside `write`, as a job's success does:
   *  a session fenced to a folder of Holi's (`fenced.ts`) at each turn's end.
   *  `made` is what this run wrote so far, each path with the hash of what
   *  it wrote there, which it adds to. */
  copyBack(
    dir: string,
    write: readonly string[],
    made: Made,
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
  exited: Promise<void>
  dropTimer?: ReturnType<typeof setTimeout>
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

/**
 * Write `data` at `abs` only if nothing is there: a file beside it, linked
 * into place, which fails when the name is taken (on a case-blind disk too)
 * however late that name came, then unlinked. False when it was taken.
 */
async function createExclusive(abs: string, data: Buffer): Promise<boolean> {
  await mkdir(dirname(abs), { recursive: true })
  const tmp = join(dirname(abs), `.holi-tmp-${randomBytes(6).toString('hex')}`)
  await writeFile(tmp, data)
  try {
    await link(tmp, abs)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined)
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

/** A live process's command line: `ps` where there is one, else (Windows)
 *  the process table through PowerShell. Null when the pid is not running.
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

export function createJobs(deps: JobsDeps): Jobs {
  const log = deps.log ?? ((msg: string) => console.log(`[agent-jobs] ${msg}`))
  const spawnJob = deps.spawn ?? defaultSpawnJob
  const probePid = deps.probePid ?? defaultProbePid
  const commandOf = deps.commandOf ?? defaultCommandOf
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

  /**
   * Signal the job's process, choosing the target from what the pid is now
   * (`pty.ts`, `signal()`, says why): the group only while it still leads
   * it, the child alone when it does not, nothing once it is gone.
   */
  function signal(job: Job, sig: 'SIGTERM' | 'SIGKILL'): void {
    const child = job.child
    if (child === null || child.pid === undefined) return
    if (process.platform === 'win32') {
      // This ChildProcess is the ownership helper itself. Killing its process
      // handle closes the Job Object; never target a Windows pid after a probe.
      try {
        child.kill(sig)
      } catch {
        // Raced with its exit.
      }
      return
    }
    switch (probePid(child.pid)) {
      case 'group-leader':
        // Reaped between the probe and here is a no-op; on Windows a child that
        // has exited is not stopped by pid, which may be another program's.
        killChildTree(child, sig)
        return
      case 'alive':
        try {
          child.kill(sig)
        } catch {
          // Raced with its exit.
        }
        return
      case 'gone':
        return
    }
  }

  async function kill(job: Job, why: string): Promise<void> {
    if (!job.busy) return
    // Set first: a copy back under way reads it, after the process is gone.
    job.stopped ??= why
    job.queue = []
    if (job.child === null) return
    signal(job, 'SIGTERM')
    const timer = setTimeout(() => signal(job, 'SIGKILL'), killGraceMs)
    await Promise.race([job.exited, new Promise((r) => setTimeout(r, killGraceMs + 5_000))])
    clearTimeout(timer)
  }

  /** Kill whatever the job's process left running in its group, so nothing
   *  changes the folder while it is copied back or the vault after its turn. */
  function killGroup(job: Job): void {
    // The Windows ownership helper closes only after its Job Object is empty.
    // POSIX still needs the group sweep after the root closes.
    if (process.platform !== 'win32' && job.child) void killChildTree(job.child, 'SIGKILL')
  }

  /** Move the current file aside atomically, then publish the replacement
   * only if the name remains free. The moved file is checked before publishing:
   * a sync write arriving after the caller's hash check is never replaced.
   * A competing file arriving while the name is free wins as well. */
  async function replaceKnown(abs: string, rel: VaultRelPath, data: Buffer, before: string) {
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
      if (!(await createExclusive(abs, data))) throw new Error(collision(rel))
    } catch (err) {
      if (moved) {
        const old = await readRegular(previous)
        try {
          // A newly arrived file owns the name; never remove or replace it.
          await link(previous, abs)
        } catch (restore) {
          if ((restore as NodeJS.ErrnoException).code !== 'EEXIST') {
            keep = true
            throw new Error(
              `${String(err)} The previous file is preserved at ${relative(deps.vault.root, previous)}.`,
            )
          }
          // Keep a changed version that could belong to the other writer.
          if (old === null || hashOf(old) !== before) keep = true
        }
      }
      if (keep) {
        throw new Error(
          `${String(err)} The previous file is preserved at ${relative(deps.vault.root, previous)}.`,
        )
      }
      throw err
    } finally {
      if (!keep) await rm(hold, { recursive: true, force: true })
    }
  }

  /**
   * Copy back what the job wrote inside its scope, `app.yaml` last, stopping
   * where a Stop came in. Returns what it wrote and what it left out (not
   * the vault's shared content, or no longer a regular file). Throws with a
   * sentence when a path cannot be written or the job wrote too much.
   */
  async function copyBack(
    job: Pick<Job, 'stopped'>,
    dir: string,
    write: readonly string[],
    made: Made,
  ): Promise<{ written: number; skipped: string[] }> {
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
      if (job.stopped !== undefined) break
      const abs = await exactPath(deps.vault.root, rel)
      if (abs === null) throw new Error(`Holi could not write ${rel}.`)
      if (job.stopped !== undefined) break
      const before = made.get(rel)
      if (before === undefined) {
        // A new file: written only where nothing is, even something that
        // arrived after the checks above (a sync bringing the same app).
        if (!(await createExclusive(abs, data))) throw new Error(collision(rel))
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
        await replaceKnown(abs, rel, data, before)
      }
      made.set(rel, hash)
      written += 1
      await deps.afterWrite?.(rel)
    }
    return { written, skipped }
  }

  const pidFile = (id: string): string => join(deps.scratchRoot, `${id}.pid`)

  /** The job leaves the list, and its agent's state goes with it. */
  function drop(job: Job): void {
    jobs.delete(job.id)
    void rm(job.state, { recursive: true, force: true }).catch(() => undefined)
  }

  /** The job's turn ended: its outcome stands until a follow-up starts
   *  another, and it leaves the list a while after the last. */
  function finish(job: Job, outcome: 'completed' | 'failed', message?: string): void {
    job.outcome = outcome
    if (message === undefined) delete job.message
    else job.message = message
    job.child = null
    job.busy = false
    if (job.dir !== null) {
      void rm(job.dir, { recursive: true, force: true }).catch(() => undefined)
      // A scratch job takes no follow-up, so its agent's state goes too.
      void rm(job.state, { recursive: true, force: true }).catch(() => undefined)
    }
    void rm(pidFile(job.id), { force: true }).catch(() => undefined)
    clearTimeout(job.dropTimer)
    job.dropTimer = setTimeout(() => {
      if (jobs.get(job.id) === job) {
        drop(job)
        push()
      }
    }, keepMs)
    job.dropTimer.unref?.()
    push()
  }

  /**
   * Run one turn of `job`: spawn it, read its events, and settle it when the
   * process closes. Copies back a scratch job's writes on success; ends a
   * vault job's turn bracket either way; sends what was queued meanwhile.
   */
  function runTurn(
    job: Job,
    run: JobRun,
    write: readonly string[],
  ): { ok: true } | { ok: false; message: string } {
    let command: ReturnType<JobsProvider['capabilities']['jobs']['command']>
    try {
      command = job.provider.capabilities.jobs.command(run)
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
    if (command === null) return { ok: false, message: job.provider.notInstalled }
    let child: ChildProcess
    try {
      child = spawnJob(command.bin, command.args, { cwd: run.cwd, env: command.env })
    } catch (err) {
      return {
        ok: false,
        message: `${job.provider.label} did not start: ${(err as Error).message}`,
      }
    }
    const { id, provider } = job
    let exitedResolve!: () => void
    job.exited = new Promise<void>((r) => (exitedResolve = r))
    job.child = child
    job.busy = true
    delete job.stopped
    if (child.pid !== undefined) {
      const line = `${child.pid}\n${run.cwd}\n`
      void mkdir(deps.scratchRoot, { recursive: true })
        .then(() => writeFile(pidFile(id), line))
        .catch(() => undefined)
    }
    clearTimeout(job.dropTimer)
    if (job.place !== null) deps.bracket?.(id, 'begin')

    let completed = false
    let failure: string | null = null
    let error: string | null = null
    let stderr = ''
    if (child.stdout !== null) {
      createInterface({ input: child.stdout }).on('line', (line) => {
        const event = provider.capabilities.jobs.event(line)
        if (event === null) return
        if (event.kind === 'thread') {
          job.thread ??= event.id
          log(`${id}: thread ${event.id}`)
        } else if (event.kind === 'turn-completed') {
          completed = true
          if (event.tokens !== undefined) {
            job.tokens += event.tokens
            push()
          }
        } else if (event.kind === 'turn-failed') failure = event.message
        else if (event.kind === 'error') error = event.message
      })
    }
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4_000)
    })
    const tooLong = setTimeout(() => void kill(job, 'The job ran too long and was stopped.'), maxMs)
    tooLong.unref?.()

    let settled = false
    const settle = async (code: number | null, sig: NodeJS.Signals | null): Promise<void> => {
      if (settled) return
      settled = true
      clearTimeout(tooLong)
      exitedResolve()
      // Whatever it left running dies with it, before anything is read.
      killGroup(job)
      if (jobs.get(id) !== job) {
        if (job.place !== null) deps.bracket?.(id, 'forget')
        return
      }
      // Exited: a Stop from here on signals nothing, since its pid may
      // already be another process's.
      job.child = null
      await provider.release?.(job.state)
      let outcome: 'completed' | 'failed'
      let why: string | undefined
      if (job.stopped !== undefined) {
        outcome = 'failed'
        why = job.stopped
      } else if (completed && failure === null && code === 0) {
        outcome = 'completed'
        if (job.dir !== null) {
          try {
            const { written, skipped } = await copyBack(job, job.dir, write, job.made)
            log(`${id}: done, ${written} file(s) written, ${skipped.length} left out`)
            why = leftOutMessage(skipped) ?? why
          } catch (err) {
            outcome = 'failed'
            why = (err as Error).message
          }
          // A Stop pressed during the copy wins.
          if (job.stopped !== undefined) {
            outcome = 'failed'
            why = job.stopped
          }
        } else log(`${id}: turn done`)
      } else {
        outcome = 'failed'
        why =
          failure ??
          error ??
          (sig !== null
            ? `${provider.label} was stopped (${sig}).`
            : `${provider.label} exited with code ${code ?? '?'}${lastLine(stderr) === '' ? '.' : `: ${lastLine(stderr)}`}`)
        log(`${id}: failed: ${why}`)
      }
      finish(job, outcome, why)
      // The outcome is on the row before the bracket's end is told, so
      // whoever hears the turn end reads it idle.
      if (job.place !== null) deps.bracket?.(id, 'end')
      // A stopped job takes nothing more, whatever came in while it stopped.
      if (job.stopped === undefined && job.queue.length > 0) void followUp(job)
    }
    // `close` waits for the output to be read to its end; `error` is a
    // process that never ran.
    child.on('close', (code, sig) => void settle(code, sig))
    child.on('error', (err) => {
      error ??= `${provider.label} did not start: ${err.message}`
      void settle(null, null)
    })
    push()
    return { ok: true }
  }

  /** Send what is queued as one turn on the job's thread. */
  function followUp(job: Job): void {
    const place = job.place
    if (place === null || job.thread === undefined || job.queue.length === 0) return
    delete job.stopped
    job.busy = true
    const text = job.queue.join('\n\n')
    job.queue = []
    const started = runTurn(
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
    if (!started.ok) finish(job, 'failed', started.message)
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
  async function sweep(): Promise<void> {
    const names = await readdir(deps.scratchRoot).catch(() => [] as string[])
    for (const name of names) {
      const id = name.endsWith('.pid') ? name.slice(0, -4) : null
      if (id === null || !JOB_SESSION_ID.test(id)) continue
      const [first = '', folder = ''] = (
        await readFile(join(deps.scratchRoot, name), 'utf8').catch(() => '')
      ).split('\n')
      const pid = Number(first.trim())
      if (!Number.isInteger(pid) || pid <= 1 || probePid(pid) !== 'group-leader') continue
      if (folder === '' || !(commandOf(pid) ?? '').includes(folder)) continue
      // Gone since: nothing to do.
      killTree(pid, 'SIGKILL')
    }
    await rm(deps.scratchRoot, { recursive: true, force: true }).catch(() => undefined)
  }
  const swept = sweep()

  /** Leaving the vault bumps it: a start that began before sees it changed
   *  and spawns nothing. */
  let generation = 0
  /** Starts getting ready (folders, copies): `leave` waits for them. */
  const starting = new Set<Promise<JobResult>>()

  /** A job's start, up to its first turn's spawn. Between its awaits the
   *  vault may be left; it then stops there, before anything runs. */
  async function begin(spec: JobSpec): Promise<JobResult> {
    const { provider, name, prompt, system, model } = spec
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

    await swept
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
      if (!started.ok) {
        drop(job)
        return started
      }
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
    if (!started.ok) {
      jobs.delete(id)
      return fail(started.message)
    }
    return { ok: true, sessionId: id }
  }

  return {
    sessions: summaries,
    has: (id) => jobs.has(id),

    async start(spec) {
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
      if (job === undefined) throw new CapabilityError('UNAVAILABLE', 'That job has ended.')
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
        clearTimeout(job.dropTimer)
        drop(job)
        push()
      }
      return { ok: true }
    },

    async leave() {
      // A start under way spawns nothing now; once each has stopped or
      // spawned, every job there is is in the list, and stopped below.
      generation += 1
      await Promise.allSettled([...starting])
      const all = [...jobs.values()]
      await Promise.all(all.map((job) => kill(job, 'Stopped.')))
      for (const job of all) clearTimeout(job.dropTimer)
      jobs.clear()
      await rm(deps.scratchRoot, { recursive: true, force: true }).catch(() => undefined)
      push()
    },

    copyBack: (dir, write, made) => copyBack({}, dir, write, made),
  }
}
