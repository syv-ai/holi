/**
 * Jobs: a prompt run once with nobody watching, for a provider with no
 * supervisor of its own but a way to run unattended (`jobs`, Codex's
 * `codex exec`). docs/features/agent-sessions.md, Jobs.
 *
 * **A job never runs in the vault.** Holi makes a scratch folder of its own
 * (`<userData>/agent-jobs/<id>/`), copies in the files the job is about, at
 * their vault paths, and runs the agent there, sandboxed by the agent's own
 * rules. What bounds a job is what it writes back, not what it reads: Codex's
 * sandbox keeps writes to the folder but can read the disk. When it succeeds,
 * its process group is killed, then only the regular files it wrote that
 * match its write scope and are the vault's shared content
 * (`isSharedContentPath`: nothing hidden, local, secret, on the agent surface
 * or named `AGENTS.md`/`CLAUDE.md`) are copied back, each checked as a vault
 * path with no symlink on the way, and any `app.yaml` last: a vault app's
 * finished marker lands after its page. What it left out it names in its
 * message. Past `MAX_COPY_FILES` or `MAX_COPY_BYTES` nothing is copied and it
 * fails. A failed or stopped job copies nothing back, and a Stop during the
 * copy stops it there. The folder is deleted either way.
 *
 * **A new folder is never written over.** A `folder/**` in the write scope
 * is where the run makes something (Create vault app's `<name>.app`): it
 * must not be in the vault when the run starts, and at each copy everything
 * in it must be what this run wrote there. When sync or anything else put
 * it there meanwhile, the copy is refused in words and nothing of it is
 * written (`takenDestination`, `copyBack`).
 *
 * Beside the folder is the agent's own state folder (`<id>.agent/`, its own
 * Codex home, say), outside what the job may write; once the process exits
 * the provider takes back what it keeps of the person's there
 * (`AgentProvider.release`), and it goes with the job.
 *
 * Beside each folder is `<id>.pid`, the process's pid, outside what the job
 * may write: a crash leaves it behind, and the next start kills that group
 * (when it still leads one and its command names the folder) before the
 * folders go.
 *
 * **It is a session in the one list**, named by Holi's id (`j` and twelve hex
 * digits): working while it runs, then idle with its `outcome` (and why, when
 * it failed) for a while, so whoever started it reads the result off the row.
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
import { defaultProbePid, writeAtomic, type PidState } from '../../../../main/plugin-api'
import type { SessionSummary } from '../claude/listing'
import type { JobsProvider, VaultRef } from '../provider'
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

interface JobSpec {
  provider: JobsProvider
  name: string
  prompt: string
  /** Put before the prompt: a job's agent has no system prompt of Holi's. */
  system?: string
  model?: string
  scope: JobScope
}

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
  spawn?: SpawnJob
  probePid?: (pid: number) => PidState
  /** A live process's command line, or null: the sweep's check that a pid
   *  left behind is still a job's. */
  commandOf?: (pid: number) => string | null
  /** SIGTERM, then this long, then SIGKILL. */
  killGraceMs?: number
  /** How long a finished job stays in the list. */
  keepMs?: number
  /** The longest a job runs before it is stopped. */
  maxMs?: number
  log?: (msg: string) => void
  /** Called after each file copied back: tests stop a job mid-copy here. */
  afterWrite?: (rel: string) => Promise<void> | void
}

export interface Jobs {
  sessions(): SessionSummary[]
  has(id: string): boolean
  start(spec: JobSpec): Promise<JobResult>
  stop(id: string): Promise<ActionResult>
  /** Stop every job and delete every scratch folder. */
  leave(): Promise<void>
  /** Copy back what `dir` holds inside `write`, as a job's success does:
   *  a session fenced to a folder of Holi's (`fenced.ts`) at each turn's end.
   *  `made` is what this run wrote into its new folders so far, which it
   *  adds to. */
  copyBack(
    dir: string,
    write: readonly string[],
    made: Set<string>,
  ): Promise<{ written: number; skipped: string[] }>
}

interface Job {
  id: string
  provider: JobsProvider
  name: string
  startedAt: number
  dir: string
  /** The agent's own state, outside `dir`. */
  state: string
  child: ChildProcess | null
  outcome?: 'done' | 'failed'
  message?: string
  /** Why it was stopped from outside, which is then its message. */
  stopped?: string
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
      state: j.outcome === undefined ? 'working' : 'idle',
      startedAt: j.startedAt,
      ...(j.outcome === undefined ? {} : { outcome: j.outcome }),
      ...(j.message === undefined ? {} : { message: j.message }),
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
    // Set first: a copy back under way reads it, after the process is gone.
    job.stopped ??= why
    if (job.child === null) return
    signal(job, 'SIGTERM')
    const timer = setTimeout(() => signal(job, 'SIGKILL'), killGraceMs)
    await Promise.race([job.exited, new Promise((r) => setTimeout(r, killGraceMs + 5_000))])
    clearTimeout(timer)
  }

  /** Kill whatever the job's process left running in its group, so nothing
   *  changes the folder while it is copied back. */
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
    job: Pick<Job, 'dir' | 'stopped'>,
    write: readonly string[],
    made: Set<string>,
  ): Promise<{ written: number; skipped: string[] }> {
    const skipped: string[] = []
    const allowed: { path: string; rel: VaultRelPath }[] = []
    let bytes = 0
    for (const path of (await filesUnder(job.dir)).filter((p) => inWriteScope(p, write))) {
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
      const stat = await lstat(join(job.dir, path)).catch(() => null)
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
        throw new Error(
          `Holi did not copy back ${folder}: something else put it in the vault while the agent worked, and Holi never writes over it.`,
        )
      }
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
      const data = await readRegular(join(job.dir, path))
      if (data === null) {
        skipped.push(rel)
        continue
      }
      if (job.stopped !== undefined) break
      await writeAtomic(deps.vault.root, rel, data)
      made.add(rel)
      written += 1
      await deps.afterWrite?.(rel)
    }
    return { written, skipped }
  }

  const pidFile = (id: string): string => join(deps.scratchRoot, `${id}.pid`)

  function finish(job: Job, outcome: 'done' | 'failed', message?: string): void {
    job.outcome = outcome
    if (message !== undefined) job.message = message
    job.child = null
    void rm(job.dir, { recursive: true, force: true }).catch(() => undefined)
    void rm(job.state, { recursive: true, force: true }).catch(() => undefined)
    void rm(pidFile(job.id), { force: true }).catch(() => undefined)
    job.dropTimer = setTimeout(() => {
      if (jobs.get(job.id) === job) {
        jobs.delete(job.id)
        push()
      }
    }, keepMs)
    job.dropTimer.unref?.()
    push()
  }

  // Scratch folders a crash left behind. A job that outlived it is killed
  // first, when its pid still leads a group whose command names its folder
  // (a pid is reused); then the folders go. A job starts once they are gone.
  async function sweep(): Promise<void> {
    const names = await readdir(deps.scratchRoot).catch(() => [] as string[])
    for (const name of names) {
      const id = name.endsWith('.pid') ? name.slice(0, -4) : null
      if (id === null || !JOB_SESSION_ID.test(id)) continue
      const pid = Number(
        (await readFile(join(deps.scratchRoot, name), 'utf8').catch(() => '')).trim(),
      )
      if (!Number.isInteger(pid) || pid <= 1 || probePid(pid) !== 'group-leader') continue
      if (!(commandOf(pid) ?? '').includes(join(deps.scratchRoot, id))) continue
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

    async start({ provider, name, prompt, system, model, scope }) {
      const id = `j${randomBytes(6).toString('hex')}`
      const dir = join(deps.scratchRoot, id)
      const state = join(deps.scratchRoot, `${id}.agent`)
      const fail = async (message: string): Promise<JobResult> => {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
        await rm(state, { recursive: true, force: true }).catch(() => undefined)
        await rm(pidFile(id), { force: true }).catch(() => undefined)
        return { ok: false, message }
      }
      await swept
      const taken = await takenDestination(deps.vault.root, scope.write)
      if (taken !== null) return fail(takenMessage(taken))
      await mkdir(dir, { recursive: true })
      await mkdir(state, { recursive: true, mode: 0o700 })
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
      let command: ReturnType<JobsProvider['capabilities']['jobs']['command']>
      try {
        command = provider.capabilities.jobs.command({
          cwd: dir,
          prompt: system === undefined ? prompt : `${system}\n\n${prompt}`,
          ...(model === undefined ? {} : { model }),
          state,
        })
      } catch (err) {
        return fail((err as Error).message)
      }
      if (command === null) return fail(provider.notInstalled)

      let child: ChildProcess
      try {
        child = spawnJob(command.bin, command.args, { cwd: dir, env: command.env })
      } catch (err) {
        return fail(`${provider.label} did not start: ${(err as Error).message}`)
      }
      let exitedResolve!: () => void
      const job: Job = {
        id,
        provider,
        name,
        startedAt: Date.now(),
        dir,
        state,
        child,
        exited: new Promise<void>((r) => (exitedResolve = r)),
      }
      jobs.set(id, job)
      if (child.pid !== undefined) {
        void writeFile(pidFile(id), `${child.pid}\n`).catch(() => undefined)
      }

      let completed = false
      let failure: string | null = null
      let error: string | null = null
      let stderr = ''
      if (child.stdout !== null) {
        createInterface({ input: child.stdout }).on('line', (line) => {
          const event = provider.capabilities.jobs.event(line)
          if (event === null) return
          if (event.kind === 'thread') log(`${id}: thread ${event.id}`)
          else if (event.kind === 'turn-completed') completed = true
          else if (event.kind === 'turn-failed') failure = event.message
          else if (event.kind === 'error') error = event.message
        })
      }
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-4_000)
      })
      const tooLong = setTimeout(
        () => void kill(job, 'The job ran too long and was stopped.'),
        maxMs,
      )
      tooLong.unref?.()

      let settled = false
      const settle = async (code: number | null, sig: NodeJS.Signals | null): Promise<void> => {
        if (settled) return
        settled = true
        clearTimeout(tooLong)
        exitedResolve()
        if (jobs.get(id) !== job) return
        // Whatever it left running dies with it, before anything is read.
        killGroup(job)
        // Exited: a Stop from here on signals nothing, since its pid may
        // already be another process's.
        job.child = null
        await provider.release?.(state)
        if (job.stopped !== undefined) return finish(job, 'failed', job.stopped)
        if (completed && failure === null && code === 0) {
          try {
            const { written, skipped } = await copyBack(job, scope.write, new Set())
            // A Stop pressed during the copy wins.
            if (job.stopped !== undefined) return finish(job, 'failed', job.stopped)
            log(`${id}: done, ${written} file(s) written, ${skipped.length} left out`)
            return finish(
              job,
              'done',
              skipped.length === 0
                ? undefined
                : `Holi left out what it may not write: ${skipped.slice(0, SHOWN_SKIPPED).join(', ')}${skipped.length > SHOWN_SKIPPED ? ` and ${skipped.length - SHOWN_SKIPPED} more` : ''}.`,
            )
          } catch (err) {
            return finish(job, 'failed', (err as Error).message)
          }
        }
        const why =
          failure ??
          error ??
          (sig !== null
            ? `${provider.label} was stopped (${sig}).`
            : `${provider.label} exited with code ${code ?? '?'}${lastLine(stderr) === '' ? '.' : `: ${lastLine(stderr)}`}`)
        log(`${id}: failed: ${why}`)
        finish(job, 'failed', why)
      }
      // `close` waits for the output to be read to its end; `error` is a
      // process that never ran.
      child.on('close', (code, sig) => void settle(code, sig))
      child.on('error', (err) => {
        error ??= `${provider.label} did not start: ${err.message}`
        void settle(null, null)
      })
      push()
      return { ok: true, sessionId: id }
    },

    async stop(id) {
      const job = jobs.get(id)
      if (job === undefined) return { ok: false, message: 'That job has ended.' }
      if (job.outcome === undefined) await kill(job, 'Stopped.')
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

    copyBack: (dir, write, made) => copyBack({ dir }, write, made),
  }
}
