import { randomUUID } from 'node:crypto'
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
}

interface PiTurn {
  begin: Promise<void>
  finalized?: Promise<void>
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
}

/** Owns one activation's RPC processes and joins every admitted turn at leave. */
export function createPiBackground(deps: PiBackgroundDeps) {
  let remote: string | null = null
  let root: string | null = null
  let invalidated = deps.activationSignal?.aborted ?? false
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
    if (turn.finalized) return turn.finalized
    turn.finalized = turn.begin.then(async () => {
      const finalEdge = edge === 'end' && invalidated ? 'forget' : edge
      await deps.bracket(job.id, finalEdge)
    })
    turn.finalized = turn.finalized.catch((error) => {
      recordFailure(error)
    })
    return turn.finalized
  }

  function close(job: PiJob): Promise<void> {
    if (!job.close) {
      job.close = job.run.close().catch((error) => {
        recordFailure(error)
        throw error
      })
      void job.close.catch(() => {})
    }
    return job.close
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
      result = { status: 'failed', output: '', error: String(error) }
    }
    if (invalidated || jobs.get(job.id) !== job) {
      await finalize(job, turn, 'forget')
      if (job.currentTurn === turn) job.busy = false
      return
    }
    if (result.status !== 'completed') {
      try {
        await close(job)
      } catch {
        /* retained for leave */
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
      if (job.keep) return
      job.retentionTimer = setTimeout(() => {
        if (jobs.get(job.id) !== job || job.busy || invalidated) return
        const expiry = track(
          (async () => {
            try {
              await close(job)
            } finally {
              if (jobs.get(job.id) === job) {
                jobs.delete(job.id)
                owned.delete(job)
                changed()
              }
            }
          })(),
        )
        void expiry.catch(recordFailure)
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
    if (invalidated) {
      void run.close().catch(recordFailure)
      return { ok: false as const, message: 'No vault is open.' }
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
    jobs.set(id, job)
    owned.add(job)
    const turn = begin(job)
    changed()
    turn.promise = track(ownTurn(job, turn, args.prompt))
    return { ok: true as const, sessionId: id }
  }

  function invalidate() {
    if (invalidated) return leave()
    invalidated = true
    remote = null
    root = null
    return leave()
  }
  function leave(): Promise<void> {
    if (leavePromise) return leavePromise
    invalidated = true
    remote = null
    root = null
    const closing = [...owned]
    for (const job of closing) {
      if (job.retentionTimer) clearTimeout(job.retentionTimer)
      job.retentionTimer = undefined
      if (jobs.get(job.id) === job) jobs.delete(job.id)
    }
    leavePromise = (async () => {
      const cleanup = await Promise.allSettled(
        closing.map(async (job) => {
          try {
            await close(job)
          } catch {
            /* retain and continue */
          }
          try {
            await Promise.allSettled([...job.turns].map((turn) => turn.promise))
          } catch (error) {
            recordFailure(error)
          }
          await Promise.all([...job.turns].map((turn) => finalize(job, turn, 'forget')))
        }),
      )
      cleanup.forEach((result) => {
        if (result.status === 'rejected') recordFailure(result.reason)
      })
      while (work.size) await Promise.allSettled([...work])
      const errors = failures.splice(0)
      if (errors.length) throw new AggregateError(errors, 'Pi background runs failed to drain.')
    })()
    return leavePromise
  }

  if (deps.activationSignal) {
    if (deps.activationSignal.aborted) void invalidate().catch(recordFailure)
    else
      deps.activationSignal.addEventListener(
        'abort',
        () => {
          void invalidate().catch(recordFailure)
        },
        { once: true },
      )
  }

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
      const operation = (async () => {
        if (invalidated || jobs.get(id) !== job) throw new Error(`no running Pi session ${id}`)
        if (job.busy) job.run.followUp(text)
        else {
          if (!job.run.isAlive) {
            if (job.retentionTimer) clearTimeout(job.retentionTimer)
            job.retentionTimer = undefined
            jobs.delete(job.id)
            owned.delete(job)
            changed()
            await close(job)
            await Promise.all([...job.turns].map((turn) => finalize(job, turn, 'forget')))
            throw new Error('Pi RPC process exited before the follow-up')
          }
          if (job.retentionTimer) clearTimeout(job.retentionTimer)
          job.retentionTimer = undefined
          const turn = begin(job)
          turn.promise = track(ownTurn(job, turn, text))
        }
      })()
      return track(operation)
    },
    async stop(id: string) {
      if (invalidated) return { ok: false as const, message: 'That session has ended.' }
      const job = jobs.get(id)
      if (!job || job.remote !== remote)
        return { ok: false as const, message: 'That session has ended.' }
      const operation = (async () => {
        if (job.retentionTimer) clearTimeout(job.retentionTimer)
        job.retentionTimer = undefined
        try {
          await close(job)
        } finally {
          await Promise.allSettled([...job.turns].map((turn) => turn.promise))
          await Promise.all([...job.turns].map((turn) => finalize(job, turn, 'forget')))
          if (jobs.get(job.id) === job) jobs.delete(job.id)
          owned.delete(job)
          if (!invalidated) changed()
        }
        return { ok: true as const }
      })()
      return track(operation)
    },
    leave,
  }
}
