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
 *   the copy stops it there. The folder is deleted either way.
 * - **The vault** (`allow`, a Holi's or an automation's run): Claude Code
 *   permission rules, which run here only when each is a folder the sandbox
 *   can make writable, or a read (`vaultSandbox`). The agent runs in the
 *   first such folder, writes the others too and nothing else; with none it
 *   is read-only. Its turns go through the vault's turn bracket, so sync
 *   pauses and each turn is recorded under the job's id, like a session's.
 *   Nothing is copied: the sandbox's writable folders are what bounds it.
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
 * row. What its turns used is its `tokens`, when the agent says.
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
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { isSharedContentPath, vaultRelPath, type VaultRelPath } from '@holi/shared'
import { exactPath } from '@holi/shared/path-safety-node'
import {
  CapabilityError,
  defaultProbePid,
  readableOrNull,
  writeAtomic,
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

/** Its own group, so a stop reaches what it started too. */
const defaultSpawnJob: SpawnJob = (bin, args, { cwd, env }) =>
  spawn(bin, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })

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
   *  a session fenced to a folder of Holi's (`fenced.ts`) at each turn's end. */
  copyBack(dir: string, write: readonly string[]): Promise<{ written: number; skipped: string[] }>
}

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
  child: ChildProcess | null
  /** A turn is under way: running, or its writes being copied back. */
  busy: boolean
  outcome?: 'done' | 'failed'
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

/**
 * Claude Code permission rules as the sandbox a vault job runs in: the vault
 * folders it may write. A read is allowed, since the sandbox reads anyway; a
 * write is a folder (`Edit(tilbud/**)`), never a file, the whole vault or a
 * hidden folder such as `.holi/`; Holi's own commands (`Bash(holi …)`) need
 * Holi's bridge, which the sandbox's lack of network keeps out of reach, so
 * they are left out. Anything else, a command or a web tool, has no sandbox
 * path, and the run is refused with the rule that stopped it.
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
    if (tool === 'Bash' && arg !== undefined && /^holi(\s|:|$)/.test(arg)) continue
    if (!WRITE_TOOLS.has(tool)) {
      return {
        ok: false,
        message: `\`${rule}\` is not a folder Codex's sandbox can allow, so this run did not start. Its sandbox allows reads and writes to named folders only.`,
      }
    }
    const path = (arg ?? '').replace(/^\.\//, '')
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

const defaultCommandOf = (pid: number): string | null => {
  try {
    return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
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
      ...(j.tokens > 0 ? { tokens: j.tokens } : {}),
      ...(j.busy || j.outcome === undefined ? {} : { outcome: j.outcome }),
      ...(j.busy || j.message === undefined ? {} : { message: j.message }),
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
    switch (probePid(child.pid)) {
      case 'group-leader':
        try {
          process.kill(-child.pid, sig)
        } catch {
          // Reaped between the probe and here.
        }
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
    const pid = job.child?.pid
    if (pid === undefined || pid <= 1) return
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // The group is already empty.
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
    const ordered = [
      ...allowed.filter(({ rel }) => !isManifest(rel)),
      ...allowed.filter(({ rel }) => isManifest(rel)),
    ]
    let written = 0
    for (const { path, rel } of ordered) {
      if (job.stopped !== undefined) break
      if ((await exactPath(deps.vault.root, rel)) === null) {
        throw new Error(`Holi could not write ${rel}.`)
      }
      const data = await readRegular(join(dir, path))
      if (data === null) {
        skipped.push(rel)
        continue
      }
      if (job.stopped !== undefined) break
      await writeAtomic(deps.vault.root, rel, data)
      written += 1
      await deps.afterWrite?.(rel)
    }
    return { written, skipped }
  }

  const pidFile = (id: string): string => join(deps.scratchRoot, `${id}.pid`)

  /** The job's turn ended: its outcome stands until a follow-up starts
   *  another, and it leaves the list a while after the last. */
  function finish(job: Job, outcome: 'done' | 'failed', message?: string): void {
    job.outcome = outcome
    if (message === undefined) delete job.message
    else job.message = message
    job.child = null
    job.busy = false
    if (job.dir !== null) void rm(job.dir, { recursive: true, force: true }).catch(() => undefined)
    void rm(pidFile(job.id), { force: true }).catch(() => undefined)
    clearTimeout(job.dropTimer)
    job.dropTimer = setTimeout(() => {
      if (jobs.get(job.id) === job) {
        jobs.delete(job.id)
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
    const command = job.provider.capabilities.jobs.command(run)
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
      let outcome: 'done' | 'failed'
      let why: string | undefined
      if (job.stopped !== undefined) {
        outcome = 'failed'
        why = job.stopped
      } else if (completed && failure === null && code === 0) {
        outcome = 'done'
        if (job.dir !== null) {
          try {
            const { written, skipped } = await copyBack(job, job.dir, write)
            log(`${id}: done, ${written} file(s) written, ${skipped.length} left out`)
            if (skipped.length > 0) {
              why = `Holi left out what it may not write: ${skipped.slice(0, SHOWN_SKIPPED).join(', ')}${skipped.length > SHOWN_SKIPPED ? ` and ${skipped.length - SHOWN_SKIPPED} more` : ''}.`
            }
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
      if (job.queue.length > 0) followUp(job)
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
    const text = job.queue.join('\n\n')
    job.queue = []
    const started = runTurn(
      job,
      {
        cwd: place.cwd,
        prompt: text,
        writable: place.writable,
        readOnly: place.readOnly,
        resume: job.thread,
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
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        // Gone since.
      }
    }
    await rm(deps.scratchRoot, { recursive: true, force: true }).catch(() => undefined)
  }
  const swept = sweep()

  return {
    sessions: summaries,
    has: (id) => jobs.has(id),

    async start(spec) {
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
        child: null,
        busy: false,
        queue: [],
        tokens: 0,
        exited: Promise.resolve(),
      }

      await swept
      if ('allow' in spec) {
        const sandbox = vaultSandbox(spec.allow)
        if (!sandbox.ok) return sandbox
        const place = await placeIn(sandbox.write)
        if (typeof place === 'string') return { ok: false, message: place }
        job.place = place
        // The agent runs in a folder of the vault, or reads it all: every
        // path it is given is the vault's.
        const where = `The vault is ${deps.vault.root}. Every vault path named here is relative to it.`
        jobs.set(id, job)
        const started = runTurn(
          job,
          {
            cwd: place.cwd,
            prompt: [system, where, prompt].filter((p) => p !== undefined).join('\n\n'),
            writable: place.writable,
            readOnly: place.readOnly,
            ...(model === undefined ? {} : { model }),
          },
          [],
        )
        if (!started.ok) {
          jobs.delete(id)
          return started
        }
        return { ok: true, sessionId: id }
      }

      const { scope } = spec
      const dir = join(deps.scratchRoot, id)
      const fail = async (message: string): Promise<JobResult> => {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
        await rm(pidFile(id), { force: true }).catch(() => undefined)
        return { ok: false, message }
      }
      await mkdir(dir, { recursive: true })
      for (const path of scope.read) {
        const abs = await exactPath(deps.vault.root, path)
        if (abs === null) return fail(`Holi could not read ${path}.`)
        await mkdir(dirname(join(dir, path)), { recursive: true })
        const copied = await copyFile(abs, join(dir, path)).then(
          () => true,
          () => false,
        )
        if (!copied) return fail(`Holi could not read ${path}.`)
      }
      job.dir = dir
      jobs.set(id, job)
      const started = runTurn(
        job,
        {
          cwd: dir,
          prompt: system === undefined ? prompt : `${system}\n\n${prompt}`,
          ...(model === undefined ? {} : { model }),
        },
        scope.write,
      )
      if (!started.ok) {
        jobs.delete(id)
        return fail(started.message)
      }
      return { ok: true, sessionId: id }
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
      followUp(job)
    },

    async stop(id) {
      const job = jobs.get(id)
      if (job === undefined) return { ok: false, message: 'That job has ended.' }
      if (job.busy) await kill(job, 'Stopped.')
      // A finished one leaves the list.
      else {
        clearTimeout(job.dropTimer)
        jobs.delete(id)
        push()
      }
      return { ok: true }
    },

    async leave() {
      const all = [...jobs.values()]
      await Promise.all(all.map((job) => kill(job, 'Stopped.')))
      for (const job of all) clearTimeout(job.dropTimer)
      jobs.clear()
      await rm(deps.scratchRoot, { recursive: true, force: true }).catch(() => undefined)
      push()
    },

    copyBack: (dir, write) => copyBack({}, dir, write),
  }
}
