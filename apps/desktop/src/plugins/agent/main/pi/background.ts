import { randomUUID } from 'node:crypto'
import { buildPiEnv } from './env'
import type { SessionSummary } from '../claude/listing'
import type { CallerOwnership } from '../host/ownership'
import type { ManagedTurn } from '../host/turn-coordinator'
import { UnconfirmedOwnedProgramError, posixLaunchNonAdmission } from '../../../../main/plugin-api'
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
  followUps: PiFollowUp[]
  turns: Set<PiTurn>
  ownership: PiOwnership
  settlement: Promise<void>
  currentTurn?: PiTurn
  staged?: { turn: PiTurn; result: PiRunResult }
  retentionTimer?: ReturnType<typeof setTimeout>
  keep: boolean
  reply?: string
  removal?: Promise<void>
  deadFollowUp?: Promise<never>
}

interface PiOwnership {
  record?: CallerOwnership
  failure?: { cause: unknown }
}

interface PiFollowUp {
  text: string
  resolve(): void
  reject(error: unknown): void
}

interface PiTurn {
  acceptingFollowUps: boolean
  managed?: { handle: ManagedTurn; deadline: AbortController }
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
  platform?: NodeJS.Platform
  bin(): string | null
  bracket(id: string, edge: 'begin' | 'end' | 'forget'): Promise<unknown> | unknown
  beginManagedTurn?: (id: string) => ManagedTurn
  changed(): void
  activationSignal?: AbortSignal
  binDir?: () => string
  env?: (binDir: string | undefined) => Record<string, string>
  /** Publishes the activation's durable link before spawn. Injected children require explicit proof. */
  allocateOwnership?: (id: string, proof: 'native' | 'explicit') => CallerOwnership
  spawn?: ConstructorParameters<typeof PiRpcRun>[0]['spawn']
}

/** Owns one activation's RPC processes and joins every admitted turn at leave. */
export function createPiBackground(deps: PiBackgroundDeps) {
  const platform = deps.platform ?? process.platform
  let remote: string | null = null
  let root: string | null = null
  let invalidated = deps.activationSignal?.aborted ?? false
  const jobs = new Map<string, PiJob>()
  const work = new Set<Promise<unknown>>()
  const failures = new Set<unknown>()
  let leavePromise: Promise<void> | undefined

  const recordFailure = (error: unknown) => failures.add(error)
  function failOwnership(owner: PiOwnership, error: unknown): unknown {
    if (owner.failure) return owner.failure.cause
    owner.failure = { cause: error }
    recordFailure(error)
    try {
      owner.record?.fail(error)
    } catch (recordError) {
      console.error('[agent] Could not persist Pi ownership failure:', recordError)
    }
    return error
  }

  function nonLaunch(owner: PiOwnership): void {
    try {
      owner.record?.nonLaunch()
      owner.record?.retire()
    } catch (error) {
      failOwnership(owner, error)
      throw error
    }
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
    (invalidated && platform !== 'win32' ? [] : [...jobs.values()]).map(
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
      let finalEdge = invalidated || job.removal ? 'forget' : edge
      if (finalEdge === 'forget' || !job.run.isAlive) {
        if (finalEdge === 'forget' && job.run.isAlive) void job.run.close()
        // Natural EOF can precede root exit. Observe its receipt without
        // converting it to an explicit stop. Only positive physical proof
        // authorizes releasing a stopped turn when the combined receipt fails.
        try {
          await job.run.drained
        } catch {
          finalEdge = 'forget'
        }
        if (invalidated || job.removal) finalEdge = 'forget'
        if (finalEdge === 'forget') await job.run.physicalDrain
      }
      if (turn.managed === undefined) await deps.bracket(job.id, finalEdge)
      else if (finalEdge === 'forget') turn.managed.handle.forget()
      else await turn.managed.handle.end(turn.managed.deadline.signal)
    })
    turn.finalized = turn.finalized.catch((error) => {
      failOwnership(job.ownership, error)
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
              const cause = failOwnership(
                job.ownership,
                new Error('Pi turn finalization timed out.'),
              )
              for (const turn of job.turns) turn.managed?.deadline.abort(cause)
              resolve()
            }, TURN_DRAIN_MS)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    }
    if (job.ownership.failure) throw job.ownership.failure.cause
  }

  const canPublish = (job: PiJob) => !invalidated && !job.removal

  function publish(job: PiJob, turn: PiTurn | undefined, result: PiRunResult): void {
    if (!canPublish(job)) return
    if (turn) {
      job.model = typeof result.model === 'string' ? result.model : job.model
      job.usage = turn.statsUpdated ? turn.usage : (summarizeUsage(result.usage) ?? job.usage)
      job.contextPercent = turn.contextPercent ?? job.contextPercent
    }
    job.state = 'idle'
    job.outcome = result.status
    job.error = result.error
    // A failed turn doesn't replace an answer already published live.
    if (result.status === 'completed') job.reply = result.output
    if (result.status === 'completed' && !job.keep) {
      job.retentionTimer = setTimeout(() => {
        if (job.currentTurn || invalidated) return
        void retire(job)
      }, RETAIN_MS)
      job.retentionTimer.unref()
    }
    try {
      changed()
    } catch (error) {
      recordFailure(error)
    }
  }

  // The owner joins history, not publication. Once drainage and that bounded
  // join succeed, durable caller settlement and retirement commit the result
  // of an exiting run. A previously published live turn is not rolled back.
  async function settle(job: PiJob): Promise<void> {
    const owner = job.ownership
    try {
      try {
        await job.run.drained
      } catch (error) {
        failOwnership(owner, error)
        if (platform === 'win32') throw error
        // A broken output stream still owes the turn's guarded forget once
        // the writer is gone. Unknown physical state must leave it open.
        await job.run.physicalDrain
      }
      await joinTurns(job)
      if (job.run.wasNotAdmitted) owner.record?.nonLaunch()
      owner.record?.settleCaller()
      owner.record?.retire()
      if (job.staged) publish(job, job.staged.turn, job.staged.result)
    } catch (error) {
      const cause = failOwnership(owner, error)
      if (job.state === 'working')
        publish(job, undefined, {
          status: 'failed',
          output: '',
          error:
            cause instanceof UnconfirmedOwnedProgramError
              ? (cause.commandError?.message ?? cause.message)
              : String(cause),
        })
      throw cause
    } finally {
      job.staged = undefined
      job.currentTurn = undefined
      rejectFollowUps(job)
    }
  }

  // All removal paths join the same settlement. A rejected job stays routable
  // to its original owner, with the same rejection on every subsequent Stop.
  function retire(job: PiJob): Promise<void> {
    clearRetention(job)
    if (job.removal) return job.removal
    job.removal = Promise.resolve().then(async () => {
      if (platform === 'win32') void job.run.close()
      await job.settlement
      if (jobs.get(job.id) === job) {
        jobs.delete(job.id)
        try {
          changed()
        } catch (error) {
          recordFailure(error)
        }
      }
    })
    // Store the removal first: synchronous process callbacks must see the
    // stopped owner. POSIX must close the GO gate before startup can resume.
    if (platform !== 'win32') void job.run.close()
    void job.removal.catch(recordFailure)
    return job.removal
  }

  async function runTurn(job: PiJob, turn: PiTurn, prompt: string): Promise<void> {
    job.state = 'working'
    job.outcome = undefined
    job.error = undefined
    changed()
    let result: PiRunResult = { status: 'aborted', output: '' }
    if (canPublish(job) && job.run.isAlive && !job.ownership.failure) {
      try {
        turn.acceptingFollowUps = true
        result = await job.run.prompt(prompt)
      } catch (error) {
        result = { status: 'failed', output: '', error: String(error) }
      }
    }
    turn.acceptingFollowUps = false
    if (result.status !== 'completed' && job.run.isAlive && canPublish(job)) void job.run.close()
    if (!job.run.isAlive || !canPublish(job)) {
      try {
        await job.run.drained
      } catch (error) {
        result = { status: 'failed', output: '', error: String(error) }
      }
    }
    const isCurrent = () => job.currentTurn === turn && canPublish(job)
    await finalize(job, turn, result.status === 'completed' ? 'end' : 'forget')
    if (!isCurrent()) return
    // This is the live-publication edge. Recheck the observed phase after
    // history, even when the semantic result arrived while stdout was open.
    // No await between this decision and either publication or staging.
    const failure = job.ownership.failure
    if (job.run.isAlive) {
      publish(
        job,
        turn,
        failure ? { status: 'failed', output: '', error: String(failure.cause) } : result,
      )
    } else if (!failure) job.staged = { turn, result }
  }

  async function ownTurn(job: PiJob, turn: PiTurn, prompt: string): Promise<void> {
    try {
      await runTurn(job, turn, prompt)
    } catch (error) {
      failOwnership(job.ownership, error)
    } finally {
      await finalize(job, turn, 'forget')
      job.turns.delete(turn)
      // Exiting turns remain current through durable owner settlement. Their
      // history promise must finish first so settlement can join it.
      if (job.currentTurn === turn && job.run.isAlive && canPublish(job)) {
        job.currentTurn = undefined
        advanceFollowUps(job)
      }
    }
  }

  function begin(job: PiJob): PiTurn {
    const turn: PiTurn = {
      acceptingFollowUps: false,
      begin: Promise.resolve(),
      promise: Promise.resolve(),
      statsUpdated: false,
    }
    job.turns.add(turn)
    job.currentTurn = turn
    if (deps.beginManagedTurn !== undefined) {
      // Claim synchronously before sending a prompt. Generic host teardown
      // cannot forget this handle even when the physical receipt rejects.
      try {
        turn.managed = { handle: deps.beginManagedTurn(job.id), deadline: new AbortController() }
      } catch (error) {
        failOwnership(job.ownership, error)
      }
    } else {
      turn.begin = Promise.resolve()
        .then(() => deps.bracket(job.id, 'begin'))
        .then(
          () => {},
          (error) => {
            failOwnership(job.ownership, error)
          },
        )
    }
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
      const binDir = deps.binDir?.()
      env = buildPiEnv(deps.env?.(binDir) ?? process.env, { binDir })
    } catch (error) {
      return refused(error)
    }
    if (invalidated) return { ok: false as const, message: 'No vault is open.' }
    const ownership: PiOwnership = {}
    try {
      ownership.record = deps.allocateOwnership?.(id, deps.spawn ? 'explicit' : 'native')
    } catch (error) {
      failOwnership(ownership, error)
      throw error
    }
    if (invalidated) {
      nonLaunch(ownership)
      return { ok: false as const, message: 'No vault is open.' }
    }
    let run: PiRpcRun
    try {
      run = new PiRpcRun({
        platform,
        ownershipRecordPath: ownership.record?.ownershipRecordPath,
        activationSignal: deps.activationSignal,
        onDrainFailure: (error) => failOwnership(ownership, error),
        beforeDrain: () => ownership.record?.beginCallerFinalization(),
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
      if (error instanceof PiRpcConfigurationError) {
        nonLaunch(ownership)
        return refused(error)
      }
      const nonAdmission = deps.spawn ? undefined : posixLaunchNonAdmission(error)
      if (nonAdmission) {
        try {
          await nonAdmission.cleanup
        } catch {
          failOwnership(ownership, error)
          throw error
        }
        nonLaunch(ownership)
        return refused(error)
      }
      // A possibly launched native child can throw with a physical cleanup
      // receipt. Record the original cause now and join cleanup without
      // reclassifying it as non-admission, even if cleanup later succeeds.
      failOwnership(ownership, error)
      try {
        await (error as { cleanup?: Promise<void> } | null)?.cleanup
      } catch {
        // Cleanup cannot replace the first failure.
      }
      throw error
    }
    if (run.startup) {
      try {
        const error = await run.startup
        if (error) {
          nonLaunch(ownership)
          return refused(error)
        }
      } catch (error) {
        failOwnership(ownership, error)
        throw error
      }
    }
    job = {
      id,
      remote: owner,
      name: args.name,
      startedAt: Date.now(),
      run,
      state: 'working',
      followUps: [],
      keep: args.keep === true,
      turns: new Set(),
      ownership,
      // The continuation reads the job only after this synchronous registration.
      settlement: Promise.resolve().then(() => settle(job)),
    }
    void job.settlement.catch(() => {})
    jobs.set(id, job)
    if (invalidated) {
      void retire(job)
      return { ok: false as const, message: 'No vault is open.' }
    }
    // A child without a receipt is already closed to RPC admission, but its
    // job stays indexed so teardown can surface that same failure.
    if (!run.isAlive) await run.drained
    startTurn(job, args.prompt)
    return { ok: true as const, sessionId: id }
  }

  function startTurn(job: PiJob, prompt: string): PiOwnership['failure'] {
    clearRetention(job)
    const turn = begin(job)
    // Only owner settlement joins turns. Tracking the raw promise in activation work
    // would let leave wait indefinitely after the bounded join has rejected.
    turn.promise = ownTurn(job, turn, prompt)
    return job.ownership.failure
  }

  function rejectFollowUps(job: PiJob): void {
    if (!job.followUps.length) return
    const failure = job.ownership.failure
    const cause = failure ? failure.cause : new Error('Pi RPC process exited before the follow-up')
    for (const next of job.followUps.splice(0)) next.reject(cause)
  }

  function advanceFollowUps(job: PiJob): void {
    if (job.ownership.failure || job.remote !== remote) {
      rejectFollowUps(job)
      return
    }
    const next = job.followUps.shift()
    if (!next) return
    const refused = startTurn(job, next.text)
    if (refused) next.reject(refused.cause)
    else next.resolve()
  }

  function leave(): Promise<void> {
    if (leavePromise) return leavePromise
    invalidated = true
    remote = null
    root = null
    // The deferred pass also joins registration interrupted by a reentrant
    // invalidation. It is not the POSIX stop edge for known owners.
    leavePromise = Promise.resolve().then(async () => {
      await Promise.allSettled([...jobs.values()].map(retire))
      while (work.size) await Promise.allSettled([...work])
      throwFailures(failures)
    })
    void leavePromise.catch(() => {})
    for (const job of jobs.values()) void retire(job)
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
      if (job.ownership.failure) throw job.ownership.failure.cause
      const turn = job.currentTurn
      if (platform === 'win32' && !job.run.isAlive) {
        if (!turn || job.state === 'idle') {
          job.deadFollowUp ??= retire(job).then(() => {
            throw new Error('Pi RPC process exited before the follow-up')
          })
          return job.deadFollowUp
        }
        throw new Error('Pi RPC process exited before the follow-up')
      }
      if (turn && !job.removal) {
        if (turn.acceptingFollowUps && job.run.isAlive && job.followUps.length === 0) {
          try {
            job.run.followUp(text)
            return
          } catch (error) {
            // RPC can resolve its result synchronously before the awaiting
            // turn resumes to close admission. Only that refusal is queued.
            if (!(error instanceof Error) || error.message !== 'Pi RPC run is not active')
              throw error
          }
        }
        // Acknowledge when dispatched, not when the next reply completes.
        // Until then the prior turn owns both publication and any failure.
        return new Promise<void>((resolve, reject) => job.followUps.push({ text, resolve, reject }))
      }
      if (!job.removal && (job.outcome === 'failed' || job.outcome === 'aborted')) {
        await job.run.drained
        throw new Error(`no running Pi session ${id}`)
      }
      if (job.removal || !job.run.isAlive) {
        await retire(job)
        throw new Error('Pi RPC process exited before the follow-up')
      }
      const refused = startTurn(job, text)
      if (refused) throw refused.cause
    },
    async stop(id: string) {
      if (invalidated && platform !== 'win32')
        return { ok: false as const, message: 'That session has ended.' }
      const job = jobs.get(id)
      if (!job || (job.remote !== remote && !invalidated))
        return { ok: false as const, message: 'That session has ended.' }
      await retire(job)
      return { ok: true as const }
    },
    leave,
  }
}
