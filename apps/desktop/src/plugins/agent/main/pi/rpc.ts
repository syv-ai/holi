import { type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  ownedProcessDrain,
  spawnOwnedProgram,
  type ProcessGroupSupervision,
} from '../../../../main/plugin-api'
import type { Readable, Writable } from 'node:stream'

type PiRunStatus = 'completed' | 'failed' | 'aborted'
export interface PiRunResult {
  status: PiRunStatus
  output: string
  error?: string
  usage?: unknown
  model?: unknown
}
type PiTurnOutcome = Omit<PiRunResult, 'output' | 'model' | 'usage'>

export interface PiRpcOptions {
  bin: string
  cwd: string
  env?: NodeJS.ProcessEnv
  model?: string
  system?: string
  /** A run with no tools at all, and nothing from the folder that could
   *  give it some: no extensions, skills, prompt templates, context files,
   *  MCP servers or project settings. It can only answer. */
  noTools?: boolean
  maxOutputBytes?: number
  maxLineBytes?: number
  onStats?: (stats: {
    usage?: { input?: number; output?: number; total?: number; cost?: number }
    contextPercent?: number
  }) => void
  spawn?: (
    bin: string,
    args: string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv; stdio: 'pipe' },
  ) => PiChild
}
export interface PiChild {
  pid?: number
  /** Spawn adapters must provide their own drain receipt; stdio close is not proof. */
  [ownedProcessDrain]?: ProcessGroupSupervision
  stdin: Writable
  stdout: Readable
  stderr: Readable
  once(event: 'error', listener: (error: Error) => void): this
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  kill(signal?: NodeJS.Signals): boolean
}

/**
 * Pi's flags for a run that can only answer (`PiRpcOptions.noTools`): every
 * tool off, and none of what could bring one back or steer the run from the
 * folder (docs: Pi's `cli.md`, Tools and Resource options).
 *
 * @public exported for its test
 */
export const NO_TOOLS = [
  '--no-tools',
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-context-files',
  '--no-mcp',
  '--no-approve',
] as const

/** One stock Pi RPC process per managed run; messages are JSON records, never shell text. */
export class PiRpcRun {
  private readonly child: PiChild
  private readonly onStats?: PiRpcOptions['onStats']
  private readonly supervision?: ProcessGroupSupervision
  private closeSeen = false
  private drainStarted = false
  private drainComplete = false
  private rejectDrained!: (error: unknown) => void
  private exited = false
  private exitError?: string
  private outputEnded = false
  private statsTimer?: ReturnType<typeof setTimeout>
  private pendingOutcome?: PiTurnOutcome
  private readonly configuredModel?: { provider: string; modelId: string }
  private modelSet = false
  private pending = ''
  private output = ''
  private parseErrors = 0
  private settled = false
  private active = false
  private started = false
  private requestId = 0
  private readonly maxOutputBytes: number
  private readonly maxLineBytes: number
  private completion?: { resolve: (result: PiRunResult) => void; reject: (error: unknown) => void }
  private resultPromise?: Promise<PiRunResult>
  private closed = false
  private model?: unknown
  private usage?: unknown
  private lastError?: string
  private phase: 'prompt' | 'setting-model' | 'idle' = 'idle'
  private readonly commands = new Map<string, { type: string; streamingBehavior?: unknown }>()
  readonly drained: Promise<void>
  private resolveDrained!: () => void

  get isAlive(): boolean {
    return !this.exited && !this.closed
  }

  constructor(options: PiRpcOptions) {
    this.drained = new Promise((resolve, reject) => {
      this.resolveDrained = resolve
      this.rejectDrained = reject
    })
    // A natural root exit can reject drainage before the activation owner calls
    // close; observe it now while preserving rejection for every owner await.
    void this.drained.catch(() => {})
    this.maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024
    this.maxLineBytes = options.maxLineBytes ?? 1024 * 1024
    this.onStats = options.onStats
    if (options.model !== undefined) {
      const slash = options.model.indexOf('/')
      if (slash <= 0 || slash === options.model.length - 1) {
        throw new Error('Pi model must be specified as provider/model-id')
      }
      this.configuredModel = {
        provider: options.model.slice(0, slash),
        modelId: options.model.slice(slash + 1),
      }
    }
    const spawn =
      options.spawn ??
      ((bin, args, opts) =>
        spawnOwnedProgram(bin, args, {
          ...opts,
          posixGroupLease: true,
        }) as ChildProcessWithoutNullStreams)
    const args = ['--mode', 'rpc']
    if (options.noTools === true) args.push(...NO_TOOLS)
    if (options.system !== undefined) args.push('--append-system-prompt', options.system)
    this.child = spawn(options.bin, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'pipe',
    })
    this.supervision = this.child[ownedProcessDrain]
    if (!this.supervision) {
      if (options.spawn === undefined && process.platform === 'win32') this.drainComplete = true
      else {
        this.drainStarted = true
        this.closed = true
        this.rejectDrained(new Error('Pi RPC process group has no retained ownership proof.'))
      }
    }
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.consume(chunk))
    const endOutput = () => {
      if (this.outputEnded) return
      this.outputEnded = true
      const tail = this.pending
      this.pending = ''
      if (tail !== '') this.readRecord(tail)
      this.finishExitedTurn()
    }
    this.child.stdout.once('end', endOutput)
    this.child.stdout.once('close', endOutput)
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', () => {})
    this.child.stdin.on('error', (error: Error) => this.failInput(error))
    this.child.once('error', (error) => {
      if (!this.exited) this.fail(error.message)
    })
    this.child.once('close', (code, signal) => {
      this.closeSeen = true
      this.rootExited(code, signal)
      endOutput()
      this.settleDrained()
    })
    this.child.once('exit', (code, signal) => this.rootExited(code, signal))
  }

  prompt(message: string): Promise<PiRunResult> {
    if (!this.isAlive || this.active)
      return Promise.reject(new Error('Pi RPC run is not available for another turn'))
    this.settled = false
    this.active = true
    this.started = false
    this.lastError = undefined
    // Each turn's result is that turn's answer, not every answer so far.
    this.output = ''
    this.phase = this.configuredModel === undefined || this.modelSet ? 'prompt' : 'setting-model'
    this.resultPromise = new Promise((resolve, reject) => {
      this.completion = { resolve, reject }
    })
    try {
      if (this.configuredModel && !this.modelSet) {
        this.pendingPrompt = message
        this.send({ type: 'set_model', ...this.configuredModel })
      } else this.sendPrompt(message)
    } catch (error) {
      this.fail(String(error))
    }
    return this.resultPromise
  }

  private pendingPrompt?: string

  /** Queue an instruction while active; Pi delivers it after the current turn. */
  steer(message: string): void {
    this.requireActive()
    this.send({ type: 'prompt', message, streamingBehavior: 'steer' })
  }

  /** Queue an instruction for after Pi finishes its current work. */
  followUp(message: string): void {
    this.requireActive()
    if (!this.isAlive) throw new Error('Pi RPC process exited before the follow-up')
    this.send({ type: 'prompt', message, streamingBehavior: 'followUp' })
  }

  cancel(): Promise<void> {
    if (this.closed) return this.drained
    if (this.isAlive) {
      try {
        this.send({ type: 'abort' })
      } catch {
        /* process may already be closing */
      }
    }
    this.closed = true
    this.finish({ status: 'aborted' })
    this.startDrain()
    return this.drained
  }

  close(): Promise<void> {
    if (this.closed) return this.drained
    this.closed = true
    if (this.active) this.finish({ status: 'aborted' })
    this.startDrain()
    return this.drained
  }

  private rootExited(code: number | null, signal: NodeJS.Signals | null): void {
    this.exited = true
    this.exitError ??= `Pi RPC exited (${code ?? signal ?? 'unknown'})`
    this.startDrain()
    // EXIT starts physical drain, but buffered JSON records still belong to
    // this turn. After EXIT, stdout EOF replaces the optional stats deadline.
    if (this.statsTimer) clearTimeout(this.statsTimer)
    this.statsTimer = undefined
    this.finishExitedTurn()
  }

  private finishExitedTurn(): void {
    if (!this.exited || !this.outputEnded || !this.active) return
    this.finish(this.pendingOutcome ?? { status: 'failed', error: this.exitError })
  }

  private settleDrained(): void {
    if (this.closeSeen && this.drainComplete) this.resolveDrained()
  }

  private startDrain(): void {
    if (this.drainStarted) return
    this.drainStarted = true
    try {
      if (this.supervision) {
        void this.supervision.drain().then(() => {
          this.drainComplete = true
          this.settleDrained()
        }, this.failDrain)
      } else if (!this.exited) this.child.kill('SIGTERM')
    } catch (error) {
      this.failDrain(error)
    }
  }

  private failDrain = (error: unknown): void => {
    this.closed = true
    this.rejectDrained(error)
    // A failed physical receipt can leave stdout open forever. Reject the
    // turn with that same reason rather than waiting for a natural outcome.
    this.takeCompletion()?.reject(error)
  }

  private requireActive(): void {
    if (this.exited || this.closed) throw new Error('Pi RPC process exited before the follow-up')
    if (!this.active || this.settled) throw new Error('Pi RPC run is not active')
  }

  private send(command: Record<string, unknown>): string {
    const id = `holi-${++this.requestId}`
    this.commands.set(id, {
      type: String(command.type),
      ...(command.streamingBehavior === undefined
        ? {}
        : { streamingBehavior: command.streamingBehavior }),
    })
    this.child.stdin.write(`${JSON.stringify({ id, ...command })}\n`, (error?: Error | null) => {
      if (error) this.failInput(error)
    })
    return id
  }

  private sendPrompt(message: string): void {
    this.phase = 'prompt'
    this.send({ type: 'prompt', message })
  }

  private consume(chunk: string): void {
    this.pending += chunk
    if (Buffer.byteLength(this.pending) > this.maxLineBytes && !this.pending.includes('\n')) {
      this.pending = ''
      this.fail('Pi RPC emitted an oversized record')
      return
    }
    let newline: number
    while ((newline = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, newline)
      this.pending = this.pending.slice(newline + 1)
      this.readRecord(line)
    }
  }

  private readRecord(line: string): void {
    if (Buffer.byteLength(line) > this.maxLineBytes) {
      this.badRecord()
      return
    }
    try {
      this.onRecord(JSON.parse(line) as Record<string, unknown>)
    } catch {
      this.badRecord()
    }
  }

  private badRecord(): void {
    if (++this.parseErrors >= 10) this.fail('Too many malformed Pi RPC records')
  }

  private onRecord(record: Record<string, unknown>): void {
    if (record.type === 'response') {
      const id = typeof record.id === 'string' ? record.id : undefined
      const request = id === undefined ? undefined : this.commands.get(id)
      if (id === undefined || request === undefined) return
      this.commands.delete(id)
      const command = request.type
      if (command === 'get_session_stats') {
        if (record.success === true && record.data && typeof record.data === 'object') {
          const data = record.data as Record<string, unknown>
          const tokens = data.tokens as Record<string, unknown> | undefined
          const context = data.contextUsage as Record<string, unknown> | undefined
          const usage = {
            ...(typeof tokens?.input === 'number' ? { input: tokens.input } : {}),
            ...(typeof tokens?.output === 'number' ? { output: tokens.output } : {}),
            ...(typeof tokens?.total === 'number' ? { total: tokens.total } : {}),
            ...(typeof data.cost === 'number' ? { cost: data.cost } : {}),
          }
          this.onStats?.({
            ...(Object.keys(usage).length ? { usage } : {}),
            ...(typeof context?.percent === 'number' ? { contextPercent: context.percent } : {}),
          })
        }
        if (this.pendingOutcome) this.finishNaturally(this.pendingOutcome)
        return
      }
      if (record.success === false) {
        this.fail(String(record.error ?? `Pi rejected ${command ?? 'command'}`))
        return
      }
      if (command === 'set_model') {
        this.modelSet = true
        if (this.isAlive && this.phase === 'setting-model' && this.pendingPrompt !== undefined) {
          const prompt = this.pendingPrompt
          this.pendingPrompt = undefined
          this.sendPrompt(prompt)
        }
        return
      }
      if (command === 'prompt') {
        const disposition = (record.data as Record<string, unknown> | undefined)?.disposition
        if (disposition === 'followUp' && record.success !== true) {
          this.fail('Pi could not queue the follow-up prompt')
        } else if (
          disposition === 'handled' &&
          request.streamingBehavior === undefined &&
          !this.started
        ) {
          // Pi's handled disposition means an extension consumed this prompt;
          // no agent_start or agent_settled will follow. Queued steer/follow-up
          // prompts must never complete the active run.
          this.finishNaturally({ status: 'completed' })
        }
      }
      return
    }
    if (!this.active) return
    if (record.type === 'agent_start') this.started = true
    if (record.type === 'message_update') {
      const event = record.assistantMessageEvent as Record<string, unknown> | undefined
      if (event?.type === 'text_delta' && typeof event.delta === 'string') this.append(event.delta)
    }
    if (record.type === 'message_end') {
      const message = record.message as Record<string, unknown> | undefined
      if (message?.role === 'assistant') {
        this.model = message.model ?? this.model
        this.usage = message.usage ?? this.usage
        if (message.stopReason === 'error') {
          this.lastError =
            typeof message.errorMessage === 'string'
              ? message.errorMessage
              : 'Pi reported a model error.'
        } else if (message.stopReason === 'stop' || message.stopReason === 'toolUse') {
          this.lastError = undefined
        }
      }
    }
    if (record.type === 'agent_settled') {
      if (this.settled || this.pendingOutcome) return
      const outcome: PiTurnOutcome = {
        status: record.aborted === true ? 'aborted' : this.lastError ? 'failed' : 'completed',
        ...(this.lastError === undefined ? {} : { error: this.lastError }),
      }
      if (this.isAlive && !this.outputEnded && this.onStats) {
        try {
          this.pendingOutcome = outcome
          const id = this.send({ type: 'get_session_stats' })
          // A spawn adapter may emit a response or exit within stdin.write.
          if (this.isAlive && this.pendingOutcome === outcome) {
            this.statsTimer = setTimeout(() => {
              this.commands.delete(id)
              this.finishNaturally(outcome)
            }, 1000)
          }
          return
        } catch {
          // Completion does not depend on optional usage data.
        }
      }
      this.finishNaturally(outcome)
    }
  }

  private append(text: string): void {
    const room = this.maxOutputBytes - Buffer.byteLength(this.output)
    if (room > 0) this.output += Buffer.from(text).subarray(0, room).toString()
  }

  private failInput(error: Error): void {
    if (!this.exited && !this.closed && !this.pendingOutcome) this.fail(error.message)
  }

  private fail(error: string): void {
    if (this.closed) return
    this.closed = true
    this.finishNaturally({ status: 'failed', error })
    this.startDrain()
  }

  private finishNaturally(outcome: PiTurnOutcome): void {
    if (this.settled) return
    if (this.exited && !this.outputEnded) this.pendingOutcome = outcome
    else this.finish(outcome)
  }

  private finish(outcome: PiTurnOutcome): void {
    this.takeCompletion()?.resolve({
      ...outcome,
      output: this.output,
      model: this.model,
      usage: this.usage,
    })
  }

  private takeCompletion() {
    if (this.settled) return
    if (this.statsTimer) clearTimeout(this.statsTimer)
    this.statsTimer = undefined
    this.pendingOutcome = undefined
    this.settled = true
    this.active = false
    this.phase = 'idle'
    this.pendingPrompt = undefined
    const completion = this.completion
    this.completion = undefined
    return completion
  }
}
