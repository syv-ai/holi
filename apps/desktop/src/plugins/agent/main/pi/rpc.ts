import { type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  ownedProcessDrain,
  posixLaunchNonAdmission,
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
type PiStats = Parameters<NonNullable<PiRpcOptions['onStats']>>[0]
const OUTPUT_DRAIN_MS = 5000

export class PiRpcConfigurationError extends Error {}

export interface PiRpcOptions {
  bin: string
  cwd: string
  env?: NodeJS.ProcessEnv
  /** A fresh record path under a trusted private parent, used only by native POSIX spawn. */
  ownershipRecordPath?: string
  activationSignal?: AbortSignal
  /** Reports the first drainage failure even while physical cleanup is still pending. */
  onDrainFailure?: (error: unknown) => void
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
  private readonly onDrainFailure?: PiRpcOptions['onDrainFailure']
  private drainFailure?: { cause: unknown }
  private readonly supervision?: ProcessGroupSupervision
  private closeSeen = false
  private drainStarted = false
  /** POSIX lease receipt, independent of output. Windows uses child close. */
  readonly physicalDrain: Promise<void>
  private resolvePhysical!: () => void
  private rejectPhysical!: (error: unknown) => void
  private physicalComplete = false
  private outputTimer?: ReturnType<typeof setTimeout>
  private windowsStopTimer?: ReturnType<typeof setTimeout>
  private outputError?: Error
  private rejectDrained!: (error: unknown) => void
  private exited = false
  private exitError?: string
  private outputEnded = false
  private statsTimer?: ReturnType<typeof setTimeout>
  private pendingOutcome?: PiTurnOutcome
  private pendingStats?: PiStats
  private readonly configuredModel?: { provider: string; modelId: string }
  private modelSet = false
  private pending = ''
  private oversizedWhitespace = false
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
    return !this.exited && !this.closed && !this.outputEnded
  }

  constructor(options: PiRpcOptions) {
    this.physicalDrain = new Promise((resolve, reject) => {
      this.resolvePhysical = resolve
      this.rejectPhysical = reject
    })
    // Reading this receipt never starts a drain; only the owner or root exit can.
    void this.physicalDrain.catch(() => {})
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
    this.onDrainFailure = options.onDrainFailure
    if (options.model !== undefined) {
      const slash = options.model.indexOf('/')
      if (slash <= 0 || slash === options.model.length - 1) {
        throw new PiRpcConfigurationError('Pi model must be specified as provider/model-id')
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
          ...(process.platform === 'win32'
            ? {}
            : {
                ownershipRecordPath: options.ownershipRecordPath,
                signal: options.activationSignal,
              }),
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
      if (options.spawn === undefined && process.platform === 'win32') {
        // Windows uses the helper's exit/output join, not a POSIX lease.
        this.physicalComplete = true
      } else {
        this.drainStarted = true
        this.failPhysical(new Error('Pi RPC process group has no retained ownership proof.'))
      }
    }
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.consume(chunk))
    this.child.stdout.once('end', () => {
      if (this.outputError) return
      this.outputEnded = true
      const tail = this.pending
      this.pending = ''
      clearTimeout(this.statsTimer)
      this.statsTimer = undefined
      // END and EXIT can arrive in either order. An active turn cannot
      // succeed on a truncated final record, even with a pending outcome.
      if (tail.trim() !== '') this.readRecord(tail, this.active)
      if (this.outputError) return
      if (this.pendingStats) {
        try {
          this.onStats?.(this.pendingStats)
        } catch {
          this.badRecord()
        }
        this.pendingStats = undefined
      }
      this.finishExitedTurn()
      this.settleOutputDrain()
    })
    this.child.stdout.once('close', () => {
      if (!this.outputEnded && !this.outputError)
        this.failOutput(new Error('Pi RPC stdout closed before end.'))
    })
    // A destroy(error) emits error before close. Keep listening even after
    // failure; the later close (or another error) must not replace its cause.
    this.child.stdout.on('error', (error: Error) => {
      if (!this.outputEnded) this.failOutput(error)
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', () => {})
    this.child.stderr.on('error', () => {})
    this.child.stdin.on('error', (error: Error) => this.failInput(error))
    this.child.once('error', (error) => {
      if (this.exited || this.closed) return
      const refusal = options.spawn === undefined ? posixLaunchNonAdmission(error) : undefined
      if (refusal) this.startDrain(refusal.cleanup)
      this.fail(error.message)
    })
    this.child.once('close', (code, signal) => {
      this.closeSeen = true
      if (this.supervision === undefined && this.physicalComplete) this.resolvePhysical()
      this.rootExited(code, signal)
      this.settleOutputDrain()
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
    clearTimeout(this.windowsStopTimer)
    this.windowsStopTimer = undefined
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

  private settleOutputDrain(): void {
    if (!this.drainStarted || !this.physicalComplete) return
    if (this.outputError) {
      this.failDrain(this.outputError)
    } else if (this.closeSeen && this.outputEnded) {
      clearTimeout(this.outputTimer)
      this.outputTimer = undefined
      this.resolveDrained()
    } else {
      // Native owns the physical deadline. This budget is only for the
      // output events that can lag behind its successful receipt.
      this.outputTimer ??= setTimeout(() => {
        const missing = !this.outputEnded ? 'stdout end' : 'child close'
        this.failOutput(new Error(`Pi RPC output drain timed out waiting for ${missing}.`))
      }, OUTPUT_DRAIN_MS)
    }
  }

  private startDrain(nonAdmissionCleanup?: Promise<void>): void {
    if (this.drainStarted) return
    this.drainStarted = true
    try {
      const physical = nonAdmissionCleanup ?? this.supervision?.drain()
      if (physical) {
        void physical.then(() => {
          this.markPhysicalComplete()
          this.settleOutputDrain()
        }, this.failPhysical)
      } else {
        this.stopWindowsHelper()
        this.settleOutputDrain()
      }
    } catch (error) {
      this.failPhysical(error)
    }
  }

  private markPhysicalComplete(): void {
    this.physicalComplete = true
    this.resolvePhysical()
  }

  private failPhysical = (error: unknown): void => {
    this.rejectPhysical(error)
    this.failDrain(error)
  }

  private stopWindowsHelper(): void {
    const signal = (name: NodeJS.Signals) => {
      if (this.exited) return
      try {
        this.child.kill(name)
      } catch {
        // A stop-file write can fail while the helper is still live. Let the
        // retry or the actual exit/output events determine settlement.
      }
    }
    signal('SIGTERM')
    if (!this.exited) {
      this.windowsStopTimer = setTimeout(() => {
        this.windowsStopTimer = undefined
        signal('SIGKILL')
      }, 1500)
      this.windowsStopTimer.unref()
    }
  }

  private failOutput(error: Error): void {
    if (this.outputError) return
    this.outputError = error
    const cause = this.rememberDrainFailure(error)
    this.pending = ''
    this.closed = true
    this.takeCompletion()?.reject(cause)
    this.startDrain()
    this.settleOutputDrain()
  }

  private rememberDrainFailure(error: unknown): unknown {
    if (!this.drainFailure) {
      this.drainFailure = { cause: error }
      this.onDrainFailure?.(error)
    }
    return this.drainFailure.cause
  }

  private failDrain = (error: unknown): void => {
    const cause = this.rememberDrainFailure(error)
    this.closed = true
    this.pending = ''
    clearTimeout(this.outputTimer)
    this.outputTimer = undefined
    this.rejectDrained(cause)
    // A failed physical receipt can leave stdout open forever. Reject the
    // turn with that same reason rather than waiting for a natural outcome.
    this.takeCompletion()?.reject(cause)
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
    if (this.outputError || (this.settled && this.closed)) return
    this.pending += chunk
    let newline: number
    while (!this.outputError && (newline = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, newline)
      this.pending = this.pending.slice(newline + 1)
      if (this.oversizedWhitespace) this.badRecord()
      else this.readRecord(line)
      this.oversizedWhitespace = false
    }
    if (this.outputError) return
    if (this.oversizedWhitespace || Buffer.byteLength(this.pending) > this.maxLineBytes) {
      const whitespace = this.pending.trim() === ''
      this.pending = ''
      // Bound even a stream of blank bytes, without treating whitespace at EOF as a record.
      this.oversizedWhitespace = whitespace
      if (!whitespace) {
        if (this.active) this.failOutput(new Error('Pi RPC emitted an oversized record'))
        else this.fail('Pi RPC emitted an oversized record')
      }
    }
  }

  private readRecord(line: string, activeTail = false): void {
    const malformed = (error: unknown) => {
      if (activeTail && error instanceof Error) this.failOutput(error)
      else this.badRecord()
    }
    if (Buffer.byteLength(line) > this.maxLineBytes) {
      malformed(new Error('Pi RPC emitted an oversized record'))
      return
    }
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
      if (activeTail && (record === null || typeof record !== 'object' || Array.isArray(record)))
        throw new SyntaxError('Invalid Pi RPC record at stdout end')
    } catch (error) {
      malformed(error)
      return
    }
    try {
      this.onRecord(record)
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
      const command = request.type
      this.commands.delete(id)
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
          const stats = {
            ...(Object.keys(usage).length ? { usage } : {}),
            ...(typeof context?.percent === 'number' ? { contextPercent: context.percent } : {}),
          }
          if (this.exited && !this.outputEnded) this.pendingStats = stats
          else this.onStats?.(stats)
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
    if (this.exited !== this.outputEnded) this.pendingOutcome = outcome
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
    this.pendingStats = undefined
    this.settled = true
    this.active = false
    this.phase = 'idle'
    this.pendingPrompt = undefined
    const completion = this.completion
    this.completion = undefined
    return completion
  }
}
