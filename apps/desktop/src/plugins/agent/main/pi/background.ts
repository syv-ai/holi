import { randomUUID } from 'node:crypto'
import { buildPiEnv } from './env'
import type { SessionSummary } from '../claude/listing'
import { PiRpcRun, type PiRunResult } from './rpc'

function summarizeUsage(raw: unknown): SessionSummary['usage'] | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const usage = raw as Record<string, unknown>
  const cost = usage.cost as Record<string, unknown> | undefined
  const result = {
    ...(typeof usage.input === 'number' ? { input: usage.input } : {}),
    ...(typeof usage.output === 'number' ? { output: usage.output } : {}),
    ...(typeof usage.totalTokens === 'number' ? { total: usage.totalTokens } : {}),
    ...(typeof cost?.total === 'number' ? { cost: cost.total } : {}),
  }
  return Object.keys(result).length ? result : undefined
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
  statsUpdated: boolean
}

export interface PiBackgroundDeps {
  bin(): string | null
  bracket(id: string, edge: 'begin' | 'end' | 'forget'): void
  changed(): void
  binDir?: () => string
  spawn?: ConstructorParameters<typeof PiRpcRun>[0]['spawn']
}

/** Owns Pi RPC processes for one active vault. It never attaches the TUI to RPC. */
export function createPiBackground(deps: PiBackgroundDeps) {
  let remote: string | null = null
  let root: string | null = null
  const jobs = new Map<string, PiJob>()
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

  async function launch(args: { name: string; prompt: string; model?: string; system?: string }) {
    if (root === null || remote === null)
      return { ok: false as const, message: 'No vault is open.' }
    const bin = deps.bin()
    if (bin === null) return { ok: false as const, message: 'Pi is not installed.' }
    let id = randomUUID().replaceAll('-', '').slice(0, 8)
    while (jobs.has(id)) id = randomUUID().replaceAll('-', '').slice(0, 8)
    let run: PiRpcRun
    try {
      run = new PiRpcRun({
        bin,
        cwd: root,
        env: buildPiEnv(process.env, { binDir: deps.binDir?.() }),
        onStats: (stats) => {
          const job = jobs.get(id)
          if (!job || job.remote !== remote) return
          if (stats.usage !== undefined) {
            job.usage = stats.usage
            job.statsUpdated = true
          }
          if (stats.contextPercent !== undefined) job.contextPercent = stats.contextPercent
          deps.changed()
        },
        ...(args.model === undefined ? {} : { model: args.model }),
        ...(args.system === undefined ? {} : { system: args.system }),
        ...(deps.spawn ? { spawn: deps.spawn } : {}),
      })
    } catch (error) {
      return { ok: false as const, message: `Could not start Pi: ${String(error)}` }
    }
    const job: PiJob = {
      id,
      remote,
      name: args.name,
      startedAt: Date.now(),
      run,
      state: 'working',
      busy: false,
      statsUpdated: false,
    }
    jobs.set(id, job)
    deps.bracket(id, 'begin')
    deps.changed()
    void runTurn(job, args.prompt)
    return { ok: true as const, sessionId: id }
  }

  async function runTurn(job: PiJob, prompt: string): Promise<void> {
    job.statsUpdated = false
    job.busy = true
    job.state = 'working'
    job.outcome = undefined
    job.error = undefined
    deps.changed()
    let result: PiRunResult
    try {
      result = await job.run.prompt(prompt)
    } catch (error) {
      result = { status: 'failed', output: '', error: String(error) }
    }
    if (jobs.get(job.id) !== job) return
    job.busy = false
    job.model = typeof result.model === 'string' ? result.model : job.model
    if (!job.statsUpdated) job.usage = summarizeUsage(result.usage) ?? job.usage
    job.state = 'idle'
    job.outcome = result.status
    job.error = result.error
    // Only a successful completion produces the turn-end event that automations
    // hear. Aborts and failures release sync without masquerading as completion.
    deps.bracket(job.id, result.status === 'completed' ? 'end' : 'forget')
    deps.changed()
    if (result.status !== 'completed') job.run.close()
  }

  return {
    setVault(nextRemote: string, nextRoot: string) {
      remote = nextRemote
      root = nextRoot
    },
    sessions,
    async launch(args: { name: string; prompt: string; model?: string; system?: string }) {
      return launch(args)
    },
    async message(id: string, text: string) {
      const job = jobs.get(id)
      if (!job || job.remote !== remote || job.outcome === 'failed' || job.outcome === 'aborted')
        throw new Error(`no running Pi session ${id}`)
      if (job.busy) job.run.followUp(text)
      else {
        deps.bracket(job.id, 'begin')
        void runTurn(job, text)
      }
    },
    async stop(id: string) {
      const job = jobs.get(id)
      if (!job || job.remote !== remote)
        return { ok: false as const, message: 'That session has ended.' }
      if (job.busy) job.run.cancel()
      else job.run.close()
      job.state = 'idle'
      job.outcome = 'aborted'
      deps.changed()
      return { ok: true as const }
    },
    async leave() {
      const oldRemote = remote
      remote = null
      root = null
      const closing = [...jobs.values()].filter((job) => job.remote === oldRemote)
      for (const job of closing) {
        job.run.close()
        jobs.delete(job.id)
        if (job.busy) deps.bracket(job.id, 'forget')
      }
      if (closing.length) deps.changed()
    },
  }
}
