import { randomUUID } from 'node:crypto'
import { buildPiEnv } from './env'
import type { SessionSummary } from '../claude/listing'
import { posixLaunchNonAdmission } from '../../../../main/plugin-api'
import { PiRpcConfigurationError, PiRpcRun, type PiRunResult } from './rpc'

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
  turnFailure?: { cause: unknown }
  currentTurn?: PiTurn
  retentionTimer?: ReturnType<typeof setTimeout>
  keep: boolean
  reply?: string
  removal?: Promise<void>
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
const TURN_DRAIN_MS = 5000

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
  /** Supplies the owner's fresh POSIX journal path before native launch. */
  ownershipRecordPath?: (id: string) => string | undefined
  spawn?: ConstructorParameters<typeof PiRpcRun>[0]['spawn']
}

/** Owns one activation's RPC processes and joins every admitted turn at leave. */
export function createPiBackground(deps: PiBackgroundDeps) {
  let remote: string | null = null
  let root: string | null = null
  let invalidated = deps.activationSignal?.aborted ?? false
  const jobs = new Map<string, PiJob>()
  const work = new Set<Promise<unknown>>()
  const failures = new Set<unknown>()
  let leavePromise: Promise<void> | undefined

  const recordFailure = (error: unknown) => failures.add(error)
  function recordTurnFailure(job: PiJob, error: unknown) {
    job.turnFailure ??= { cause: error }
  }
  function throwFailures(reasons: Set<unknown>): void {
    const errors = [...reasons]
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'Pi background runs failed to drain.')
  }
  function track<T>(promise: Promise<T>): Promise<T> {
    work.add(promise)
    void promise.finally(() => work.delete(promise)).catch(() => {})
    return promise
  }
  const changed = () => {
    if (!invalidated) deps.changed()
  }
  const sessions = (): SessionSummary[] =>
    (invalidated ? [] : [...jobs.values()]).map(
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
      recordTurnFailure(job, error)
    })
    return turn.finalized
  }

  function clearRetention(job: PiJob): void {
    if (job.retentionTimer) clearTimeout(job.retentionTimer)
    job.retentionTimer = undefined
  }

  async function joinTurns(job: PiJob): Promise<void> {
    if (job.turns.size) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          Promise.allSettled([...job.turns].map((turn) => turn.promise)),
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              recordTurnFailure(job, new Error('Pi turn finalization timed out.'))
              resolve()
            }, TURN_DRAIN_MS)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    }
    if (job.turnFailure) throw job.turnFailure.cause
  }

  // All removal paths join this receipt. A rejected job must remain routable
  // to its original owner, with the same rejection on every subsequent Stop.
  function retire(job: PiJob): Promise<void> {
    clearRetention(job)
    if (job.removal) return job.removal
    job.removal = Promise.resolve().then(async () => {
      await job.run.close()
      await joinTurns(job)
      if (jobs.get(job.id) === job) {
        jobs.delete(job.id)
        try {
          changed()
        } catch (error) {
          recordFailure(error)
        }
      }
    })
    void job.removal.catch(recordFailure)
    return job.removal
  }

  async function runTurn(job: PiJob, turn: PiTurn, prompt: string): Promise<void> {
    job.busy = true
    job.state = 'working'
    job.outcome = undefined
    job.error = undefined
    changed()
    let result: PiRunResult = { status: 'aborted', output: '' }
    if (!invalidated && !job.removal) {
      try {
        result = await job.run.prompt(prompt)
      } catch (error) {
        result = { status: 'failed', output: '', error: String(error) }
      }
    }
    if (invalidated || job.removal || !job.run.isAlive || result.status !== 'completed') {
      try {
        await job.run.close()
      } catch (error) {
        // Exiting turns may have parsed a complete reply before physical and
        // output drainage settles. Only a successful receipt can publish it.
        result = { status: 'failed', output: '', error: String(error) }
      }
    }
    if (invalidated || job.removal) {
      await finalize(job, turn, 'forget')
      if (job.currentTurn === turn) job.busy = false
      return
    }
    const isCurrent = () => job.currentTurn === turn && !invalidated && !job.removal
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
        if (job.busy || invalidated) return
        void retire(job)
      }, RETAIN_MS)
      job.retentionTimer.unref()
    }
  }

  async function ownTurn(job: PiJob, turn: PiTurn, prompt: string): Promise<void> {
    try {
      await runTurn(job, turn, prompt)
    } catch (error) {
      recordTurnFailure(job, error)
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
          recordTurnFailure(job, error)
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
    while (jobs.has(id)) id = randomUUID().replaceAll('-', '').slice(0, 8)
    let job!: PiJob
    const refused = (error: unknown) => ({
      ok: false as const,
      message: `Could not start Pi: ${String(error)}`,
    })
    let env: NodeJS.ProcessEnv
    try {
      if (invalidated) return { ok: false as const, message: 'No vault is open.' }
      env = (deps.env ?? ((binDir) => buildPiEnv(process.env, { binDir })))(deps.binDir?.())
    } catch (error) {
      return refused(error)
    }
    if (invalidated) return { ok: false as const, message: 'No vault is open.' }
    let run: PiRpcRun
    try {
      const ownershipRecordPath =
        deps.spawn || process.platform === 'win32' ? undefined : deps.ownershipRecordPath?.(id)
      if (invalidated) return { ok: false as const, message: 'No vault is open.' }
      run = new PiRpcRun({
        ownershipRecordPath,
        activationSignal: deps.activationSignal,
        bin,
        cwd,
        env,
        onStats: (stats) => {
          if (invalidated || !job || job.removal || jobs.get(id) !== job) return
          const turn = job.currentTurn
          if (!turn) return
          if (stats.usage !== undefined) {
            turn.usage = stats.usage
            turn.statsUpdated = true
          }
          if (stats.contextPercent !== undefined) turn.contextPercent = stats.contextPercent
        },
        ...(args.model === undefined ? {} : { model: args.model }),
        ...(args.system === undefined ? {} : { system: args.system }),
        ...(args.noTools === true ? { noTools: true } : {}),
        ...(deps.spawn ? { spawn: deps.spawn } : {}),
      })
    } catch (error) {
      if (error instanceof PiRpcConfigurationError) return refused(error)
      const nonAdmission = deps.spawn ? undefined : posixLaunchNonAdmission(error)
      // A possibly launched native child can throw with a physical cleanup
      // receipt. Joining it does not reclassify that throw as non-admission.
      const cleanup =
        nonAdmission?.cleanup ?? (error as { cleanup?: Promise<void> } | null)?.cleanup
      if (cleanup) {
        try {
          await cleanup
          if (nonAdmission) return refused(error)
          if (deps.spawn) recordFailure(error) // A fake throw is not a typed child receipt.
        } catch (failure) {
          recordFailure(error)
          recordFailure(failure)
        }
      } else recordFailure(error)
      throw error
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
    if (invalidated) return { ok: false as const, message: 'No vault is open.' }
    // A child without a receipt is already closed to RPC admission, but its
    // job stays indexed so teardown can surface that same failure.
    if (!run.isAlive) await run.drained
    startTurn(job, args.prompt)
    return { ok: true as const, sessionId: id }
  }

  function startTurn(job: PiJob, prompt: string): void {
    const turn = begin(job)
    // Only retire joins turns. Tracking the raw promise in activation work
    // would let leave wait indefinitely after the bounded join has rejected.
    turn.promise = ownTurn(job, turn, prompt)
  }

  function leave(): Promise<void> {
    if (leavePromise) return leavePromise
    invalidated = true
    remote = null
    root = null
    // Close admission now, then let a synchronous spawn interrupted by abort
    // finish registering its child (or failed-start receipt) before scanning.
    leavePromise = Promise.resolve().then(async () => {
      await Promise.allSettled([...jobs.values()].map(retire))
      while (work.size) await Promise.allSettled([...work])
      throwFailures(failures)
    })
    void leavePromise.catch(() => {})
    return leavePromise
  }

  if (deps.activationSignal?.aborted) void leave()
  else
    deps.activationSignal?.addEventListener(
      'abort',
      () => {
        void leave()
      },
      { once: true },
    )

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
      if (!job || job.remote !== remote) throw new Error(`no running Pi session ${id}`)
      if (!job.removal && (job.outcome === 'failed' || job.outcome === 'aborted')) {
        await job.run.drained
        throw new Error(`no running Pi session ${id}`)
      }
      if (job.removal || !job.run.isAlive) {
        await retire(job)
        throw new Error('Pi RPC process exited before the follow-up')
      }
      if (job.busy) job.run.followUp(text)
      else {
        clearRetention(job)
        startTurn(job, text)
      }
    },
    async stop(id: string) {
      if (invalidated) return { ok: false as const, message: 'That session has ended.' }
      const job = jobs.get(id)
      if (!job || job.remote !== remote)
        return { ok: false as const, message: 'That session has ended.' }
      await retire(job)
      return { ok: true as const }
    },
    leave,
  }
}
