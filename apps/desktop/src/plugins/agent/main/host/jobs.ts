/**
 * Jobs: a prompt run once with nobody watching, for a provider with no
 * supervisor of its own but a way to run unattended (`jobs`, Codex's
 * `codex exec`). docs/features/agent-sessions.md, Jobs.
 *
 * **A job never runs in the vault.** Holi makes a scratch folder of its own
 * (`<userData>/agent-jobs/<id>/`), copies in the files the job may read, at
 * their vault paths, and runs the agent there, sandboxed by the agent's own
 * rules. When it succeeds, only the files it wrote that match its write scope
 * are copied back, each checked as a vault path with no symlink on the way,
 * and any `app.yaml` last: a vault app's finished marker lands after its page.
 * A failed or stopped job copies nothing back. The folder is deleted either
 * way.
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
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { vaultRelPath, type VaultRelPath } from '@holi/shared'
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
  /** SIGTERM, then this long, then SIGKILL. */
  killGraceMs?: number
  /** How long a finished job stays in the list. */
  keepMs?: number
  /** The longest a job runs before it is stopped. */
  maxMs?: number
  log?: (msg: string) => void
}

export interface Jobs {
  sessions(): SessionSummary[]
  has(id: string): boolean
  start(spec: JobSpec): Promise<JobResult>
  stop(id: string): Promise<ActionResult>
  /** Stop every job and delete every scratch folder. */
  leave(): Promise<void>
}

interface Job {
  id: string
  provider: JobsProvider
  name: string
  startedAt: number
  dir: string
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
    if (job.child === null) return
    job.stopped ??= why
    signal(job, 'SIGTERM')
    const timer = setTimeout(() => signal(job, 'SIGKILL'), killGraceMs)
    await Promise.race([job.exited, new Promise((r) => setTimeout(r, killGraceMs + 5_000))])
    clearTimeout(timer)
  }

  /** Copy back what the job wrote inside its scope, `app.yaml` last. Throws
   *  with the path it could not write. */
  async function copyBack(job: Job, write: readonly string[]): Promise<number> {
    const found = (await filesUnder(job.dir)).filter((rel) => inWriteScope(rel, write))
    const ordered = [
      ...found.filter((rel) => !isManifest(rel)),
      ...found.filter((rel) => isManifest(rel)),
    ]
    for (const path of ordered) {
      let rel: VaultRelPath
      try {
        rel = vaultRelPath(path)
      } catch {
        continue
      }
      if ((await exactPath(deps.vault.root, rel)) === null) {
        throw new Error(`Holi could not write ${rel}.`)
      }
      await writeAtomic(deps.vault.root, rel, await readFile(join(job.dir, path)))
    }
    return ordered.length
  }

  function finish(job: Job, outcome: 'done' | 'failed', message?: string): void {
    job.outcome = outcome
    if (message !== undefined) job.message = message
    job.child = null
    void rm(job.dir, { recursive: true, force: true }).catch(() => undefined)
    job.dropTimer = setTimeout(() => {
      if (jobs.get(job.id) === job) {
        jobs.delete(job.id)
        push()
      }
    }, keepMs)
    job.dropTimer.unref?.()
    push()
  }

  // Scratch folders a crash left behind: nothing runs in them now. A job
  // starts once they are gone.
  const swept = rm(deps.scratchRoot, { recursive: true, force: true }).catch(() => undefined)

  return {
    sessions: summaries,
    has: (id) => jobs.has(id),

    async start({ provider, name, prompt, system, model, scope }) {
      const id = `j${randomBytes(6).toString('hex')}`
      const dir = join(deps.scratchRoot, id)
      const fail = async (message: string): Promise<JobResult> => {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
        return { ok: false, message }
      }
      await swept
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
      const command = provider.capabilities.jobs.command({
        cwd: dir,
        prompt: system === undefined ? prompt : `${system}\n\n${prompt}`,
        ...(model === undefined ? {} : { model }),
      })
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
        child,
        exited: new Promise<void>((r) => (exitedResolve = r)),
      }
      jobs.set(id, job)

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
        if (job.stopped !== undefined) return finish(job, 'failed', job.stopped)
        if (completed && failure === null && code === 0) {
          try {
            const written = await copyBack(job, scope.write)
            log(`${id}: done, ${written} file(s) written`)
            return finish(job, 'done')
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
  }
}
