import { randomUUID } from 'node:crypto'
import { UnconfirmedOwnedProgramError } from '../../../../main/plugin-api'
import { buildPiEnv } from './env'
import type { SessionSummary } from '../claude/listing'
import { PiRpcRun, type PiRunResult } from './rpc'

function summarizeUsage(raw: unknown): SessionSummary['usage'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const cost =
    value.cost && typeof value.cost === 'object'
      ? (value.cost as Record<string, unknown>)
      : undefined
  const usage: NonNullable<SessionSummary['usage']> = {}
  for (const key of ['input', 'output'] as const) {
    if (typeof value[key] === 'number') usage[key] = value[key]
  }
  const total = typeof value.total === 'number' ? value.total : value.totalTokens
  if (typeof total === 'number') usage.total = total
  if (typeof value.cost === 'number') usage.cost = value.cost
  else if (typeof cost?.total === 'number') usage.cost = cost.total
  return Object.keys(usage).length ? usage : undefined
}

interface PiJob {
  id: string
  remote: string
  name: string
  startedAt: number
  run: PiRpcRun
  state: SessionSummary['state']
  outcome?: SessionSummary['outcome']
  error?: string
  model?: string
  usage?: SessionSummary['usage']
  contextPercent?: number
  busy: boolean
  turns: Set<PiTurn>
  currentTurn?: PiTurn
  retentionTimer?: ReturnType<typeof setTimeout>
  keep: boolean
  reply?: string
  close?: Promise<void>
  retirement?: Promise<void>
  followUpRejection?: Promise<never>
}

interface PiTurn {
  begin: Promise<void>
  finalization?: Promise<void>
  finalized: boolean
  promise: Promise<void>
  statsUpdated: boolean
  usage?: SessionSummary['usage']
  contextPercent?: number
}

const RETAIN_MS = 30_000

export interface PiLaunch {
  name: string
  prompt: string
  model?: string
  system?: string
  noTools?: boolean
  keep?: boolean
}

export interface PiBackgroundDeps {
  bin(): string | null
  bracket(id: string, edge: 'begin' | 'end' | 'forget'): Promise<unknown> | unknown
  changed(): void
  activationSignal?: AbortSignal
  binDir?: () => string
  env?: (binDir: string | undefined) => Record<string, string>
  spawn?: ConstructorParameters<typeof PiRpcRun>[0]['spawn']
  /** Owning activation platform, captured independently of ambient test state. */
  platform?: NodeJS.Platform
}

/** Owns one activation's RPC processes and joins every admitted turn at leave. */
export function createPiBackground(deps: PiBackgroundDeps) {
  let remote: string | null = null
  let root: string | null = null
  let invalidated = deps.activationSignal?.aborted ?? false
  const platform = deps.platform ?? process.platform
  const jobs = new Map<string, PiJob>()
  const owned = new Set<PiJob>()
  const work = new Set<Promise<unknown>>()
  const failures: unknown[] = []
  let leavePromise: Promise<void> | undefined

  const recordFailure = (error: unknown) => failures.push(error)
  function track<T>(promise: Promise<T>): Promise<T> {
    work.add(promise)
    void promise.finally(() => work.delete(promise)).catch(() => {})
    return promise
  }
  const changed = () => {
    if (!invalidated) deps.changed()
  }
  const sessions = (): SessionSummary[] =>
    [...jobs.values()].map(
      ({ id, name, state, startedAt, model, usage, contextPercent, outcome, error }) => ({
        id,
        provider: 'pi',
        name,
        state,
        startedAt,
        ...(model === undefined ? {} : { model }),
        ...(usage === undefined ? {} : { usage }),
        ...(contextPercent === undefined ? {} : { contextPercent }),
        ...(outcome === undefined ? {} : { outcome }),
        ...(error === undefined ? {} : { error }),
      }),
    )

  function finalize(job: PiJob, turn: PiTurn, edge: 'end' | 'forget'): Promise<void> {
    return (turn.finalization ??= turn.begin.then(async () => {
      const finalEdge = edge === 'end' && invalidated ? 'forget' : edge
      try {
        await deps.bracket(job.id, finalEdge)
      } catch (error) {
        recordFailure(error)
      } finally {
        turn.finalized = true
      }
    }))
  }

  function clearRetention(job: PiJob): void {
    clearTimeout(job.retentionTimer)
    job.retentionTimer = undefined
  }

  function close(job: PiJob): Promise<void> {
    if (!job.close) {
      // Revoke admission before requesting stop. The drain promise and any
      // failure (including its cleanup lease) always belong to this launch.
      job.close = job.run.drained
      clearRetention(job)
      void job.run.close()
    }
    return job.close
  }

  function retire(job: PiJob): Promise<void> {
    job.retirement ??= job.run.drained.then(async () => {
      await Promise.all([...job.turns].map((turn) => turn.promise))
      const hadRow = jobs.get(job.id) === job
      if (hadRow) jobs.delete(job.id)
      owned.delete(job)
      if (hadRow) changed()
    })
    void close(job)
    return job.retirement
  }

  async function runTurn(job: PiJob, turn: PiTurn, prompt: string): Promise<void> {
    job.busy = true
    job.state = 'working'
    job.outcome = undefined
    job.error = undefined
    if (!invalidated) changed()
    let result: PiRunResult
    try {
      result = await job.run.prompt(prompt)
    } catch (error) {
      result = {
        status: 'failed',
        output: '',
        error:
          error instanceof UnconfirmedOwnedProgramError
            ? (error.commandError?.message ?? error.message)
            : String(error),
      }
    }
    if (result.status !== 'completed') {
      try {
        await close(job)
      } catch {
        /* Stop and leave observe the original failure on this owner. */
      }
    }
    if (invalidated || jobs.get(job.id) !== job) {
      await finalize(job, turn, 'forget')
      if (job.currentTurn === turn) job.busy = false
      return
    }
    const isCurrent = () => job.currentTurn === turn && !invalidated && jobs.get(job.id) === job
    if (isCurrent()) {
      job.model = typeof result.model === 'string' ? result.model : job.model
      job.usage = turn.statsUpdated ? turn.usage : (summarizeUsage(result.usage) ?? job.usage)
      job.contextPercent = turn.contextPercent ?? job.contextPercent
      job.busy = false
      job.state = 'idle'
      job.outcome = result.status
      job.error = result.error
    }
    await finalize(job, turn, result.status === 'completed' ? 'end' : 'forget')
    if (!isCurrent()) return
    changed()
    if (result.status === 'completed') {
      job.reply = result.output
      if (job.keep || job.close) return
      job.retentionTimer = setTimeout(() => {
        if (jobs.get(job.id) !== job || job.busy || invalidated) return
        // A failed expiry keeps its owner, row and rejection for Stop/leave.
        void retire(job).catch(() => undefined)
      }, RETAIN_MS)
      job.retentionTimer.unref()
    }
  }

  async function ownTurn(job: PiJob, turn: PiTurn, prompt: string): Promise<void> {
    try {
      await runTurn(job, turn, prompt)
    } catch (error) {
      recordFailure(error)
    } finally {
      await finalize(job, turn, 'forget')
      job.turns.delete(turn)
      if (job.currentTurn === turn) job.currentTurn = undefined
    }
  }

  function begin(job: PiJob): PiTurn {
    const turn: PiTurn = {
      begin: Promise.resolve(),
      finalized: false,
      promise: Promise.resolve(),
      statsUpdated: false,
    }
    turn.begin = Promise.resolve()
      .then(() => deps.bracket(job.id, 'begin'))
      .then(
        () => {},
        (error) => {
          recordFailure(error)
        },
      )
    job.turns.add(turn)
    job.currentTurn = turn
    return turn
  }

  async function launch(args: PiLaunch) {
    if (invalidated || root === null || remote === null)
      return { ok: false as const, message: 'No vault is open.' }
    const owner = remote
    const cwd = root
    const bin = deps.bin()
    if (bin === null) return { ok: false as const, message: 'Pi is not installed.' }
    let id = randomUUID().replaceAll('-', '').slice(0, 8)
    while ([...owned].some((job) => job.id === id))
      id = randomUUID().replaceAll('-', '').slice(0, 8)
    let job!: PiJob
    let run: PiRpcRun
    try {
      if (invalidated) return { ok: false as const, message: 'No vault is open.' }
      run = new PiRpcRun({
        bin,
        platform,
        cwd,
        env: (deps.env ?? ((binDir) => buildPiEnv(process.env, { binDir })))(deps.binDir?.()),
        onStats: (stats) => {
          if (invalidated || jobs.get(id) !== job) return
          const turn = job.currentTurn
          if (!turn) return
          if (stats.usage !== undefined) {
            turn.usage = stats.usage
            turn.statsUpdated = true
          }
          if (stats.contextPercent !== undefined) turn.contextPercent = stats.contextPercent
          changed()
        },
        ...(args.model === undefined ? {} : { model: args.model }),
        ...(args.system === undefined ? {} : { system: args.system }),
        ...(args.noTools === true ? { noTools: true } : {}),
        ...(deps.spawn ? { spawn: deps.spawn } : {}),
      })
    } catch (error) {
      return { ok: false as const, message: `Could not start Pi: ${String(error)}` }
    }
    job = {
      id,
      remote: owner,
      name: args.name,
      startedAt: Date.now(),
      run,
      state: 'working',
      busy: false,
      keep: args.keep === true,
      turns: new Set(),
    }
    owned.add(job)
    if (invalidated) {
      // A synchronous launch adapter can invalidate before the owner is registered.
      await retire(job).catch(recordFailure)
      return { ok: false as const, message: 'No vault is open.' }
    }
    if (run.startup) {
      const error = await run.startup
      if (error) {
        await retire(job)
        return { ok: false as const, message: `Could not start Pi: ${String(error)}` }
      }
      if (invalidated || remote !== owner || root !== cwd) {
        await retire(job)
        return { ok: false as const, message: 'No vault is open.' }
      }
    }
    jobs.set(id, job)
    const turn = begin(job)
    changed()
    turn.promise = track(ownTurn(job, turn, args.prompt))
    return { ok: true as const, sessionId: id }
  }

  function leave(): Promise<void> {
    if (leavePromise) return leavePromise
    invalidated = true
    // Keep the original remote only for Stop on an owner still retiring.
    root = null
    deps.activationSignal?.removeEventListener('abort', onAbort)
    leavePromise = (async () => {
      const cleanup = await Promise.allSettled([...owned].map(retire))
      cleanup.forEach((result) => {
        if (result.status === 'rejected') recordFailure(result.reason)
      })
      while (work.size) await Promise.allSettled([...work])
      if (failures.length === 1 && failures[0] instanceof UnconfirmedOwnedProgramError)
        throw failures[0]
      if (failures.length) throw new AggregateError(failures, 'Pi background runs failed to drain.')
    })()
    return leavePromise
  }

  function onAbort() {
    // The activation host also joins leave; observe without replacing its error.
    void leave().catch(() => undefined)
  }
  if (deps.activationSignal?.aborted) onAbort()
  else deps.activationSignal?.addEventListener('abort', onAbort, { once: true })

  return {
    setVault(nextRemote: string, nextRoot: string) {
      if (invalidated) return
      remote = nextRemote
      root = nextRoot
    },
    sessions,
    launch: (args: PiLaunch) => track(launch(args)),
    reply(id: string): string | null {
      const job = jobs.get(id)
      return invalidated || job === undefined || job.remote !== remote ? null : (job.reply ?? null)
    },
    async message(id: string, text: string) {
      if (invalidated) throw new Error(`no running Pi session ${id}`)
      const job = jobs.get(id)
      if (!job || job.remote !== remote || job.outcome === 'failed' || job.outcome === 'aborted')
        throw new Error(`no running Pi session ${id}`)
      if (job.close || !job.run.isAlive) {
        const message = 'Pi RPC process exited before the follow-up'
        // Exit ends admission, not a buffered or finalizing turn. The set also
        // tracks finalized turns until their bookkeeping unwinds, so membership
        // alone doesn't mean the owner is still working.
        if (!job.close && [...job.turns].some((turn) => !turn.finalized)) {
          throw new Error(message)
        }
        // Retirement joins the original drain. Only the admission promise gets
        // a generic error, and only after successful retirement.
        return (job.followUpRejection ??= retire(job).then(() => {
          throw new Error(message)
        }))
      }
      if (job.busy) job.run.followUp(text)
      else {
        clearRetention(job)
        const turn = begin(job)
        turn.promise = track(ownTurn(job, turn, text))
      }
    },
    async stop(id: string) {
      const job = jobs.get(id)
      if (!job || job.remote !== remote)
        return { ok: false as const, message: 'That session has ended.' }
      await retire(job)
      return { ok: true as const }
    },
    leave,
  }
}
