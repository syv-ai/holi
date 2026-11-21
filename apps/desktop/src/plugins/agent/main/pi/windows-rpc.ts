import {
  joinOwnedProgram,
  spawnOwnedProgram,
  type ManagedOwnedChild,
  type UnconfirmedOwnedProgramError,
} from '../../../../main/plugin-api'

import { NO_TOOLS, PiRpcConfigurationError, type PiRpcOptions, type PiRunResult } from './rpc'

/** One stock Pi RPC process per managed run; messages are JSON records, never shell text. */
export class WindowsPiRpcRun {
  private readonly child: ManagedOwnedChild
  private readonly onStats?: PiRpcOptions['onStats']
  private exited = false
  private statsTimer?: ReturnType<typeof setTimeout>
  private statsPending?: PiRunResult
  private readonly exitPublications: (() => void)[] = []
  private exitSettlementQueued = false
  private exitVerified = false
  private exitError?: string
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
  private completion?: {
    resolve(result: PiRunResult): void
    reject(error: UnconfirmedOwnedProgramError): void
  }
  private closed = false
  private model?: unknown
  private usage?: unknown
  private lastError?: string
  private phase: 'prompt' | 'setting-model' | 'idle' = 'idle'
  private readonly commands = new Map<string, { type: string; streamingBehavior?: unknown }>()
  /** Present for Windows launches without a helper PID, which need classification before use. */
  readonly startup?: Promise<Error | null>
  /** Only unknown ownership rejects; command and output failures are turn/launch errors. */
  readonly drained: Promise<void>
  wasNotAdmitted = false
  get physicalDrain(): Promise<void> {
    return this.drained
  }

  private get windowsExitKnown(): boolean {
    // Node sets these before emitting exit, so an earlier listener can flush
    // stdout before our own synchronous exit listener runs.
    return true && (this.exited || this.child.exitCode != null || this.child.signalCode != null)
  }

  get isAlive(): boolean {
    return !this.exited && !this.closed && !this.windowsExitKnown
  }

  constructor(options: PiRpcOptions) {
    this.maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024
    this.maxLineBytes = options.maxLineBytes ?? 1024 * 1024
    this.onStats = options.onStats
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
    const args = ['--mode', 'rpc']
    if (options.noTools === true) args.push(...NO_TOOLS)
    if (options.system !== undefined) args.push('--append-system-prompt', options.system)
    this.child = (
      options.spawn
        ? options.spawn(options.bin, args, { cwd: options.cwd, env: options.env, stdio: 'pipe' })
        : spawnOwnedProgram(options.bin, args, {
            cwd: options.cwd,
            env: options.env,
            stdio: 'pipe',
          })
    ) as ManagedOwnedChild
    const child = this.child
    const windows = true
    const joined = joinOwnedProgram(child, 'win32')
    const sources = new Set([child, child.stdin, child.stdout, child.stderr])
    const onError = (error: Error) => this.fail(error.message)
    const onData = (chunk: string) => {
      if (!this.closed) this.consume(chunk)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      this.exited = true
      // Pi can exit while a tool holds the POSIX group. Preserve escalation
      // until child close. On Windows the join classifies the exit and output.
      if (windows) this.clearStatsTimer()
      else
        this.finish({
          status: 'failed',
          output: this.output,
          error: `Pi RPC exited (${code ?? signal ?? 'unknown'})`,
        })
    }
    const onClose = () => {
      this.exited = true
      if (windows) this.clearStatsTimer()
    }
    for (const source of sources) source?.on('error', onError)
    child.once('exit', onExit)
    child.once('close', onClose)
    child.stdout?.setEncoding('utf8').on('data', onData)
    child.stderr?.resume()

    const release = () => {
      this.exited = true
      child.off('exit', onExit)
      child.off('close', onClose)
      child.stdout?.off('data', onData)
      // Discard late output without retaining the RPC parser. The shared join
      // keeps late error events handled even when receipt failure came first.
      child.stdout?.resume()
      for (const source of sources) source?.off('error', onError)
      this.commands.clear()
      this.exitPublications.length = 0
      this.pending = ''
    }
    this.drained = joined.then(
      ({ code, signal, error, ownership }) => {
        this.exited = true
        this.wasNotAdmitted = ownership === 'not-started'
        if (windows && !this.closed && ownership === 'empty' && code === 0 && signal === null) {
          // EMPTY alone does not verify the pipes. Only the full join can
          // authorize a buffered event or acknowledgement to complete a turn.
          child.stdout?.off('data', onData)
          if (!error && this.pending.length) this.exitError ??= 'Incomplete Pi RPC record at exit'
          if (!error && this.exitError === undefined) {
            this.exitVerified = true
            this.flushExitPublications()
          }
        }
        this.finish({
          status: 'failed',
          output: this.output,
          error:
            error?.message ?? this.exitError ?? `Pi RPC exited (${code ?? signal ?? 'unknown'})`,
        })
        release()
      },
      (failure: UnconfirmedOwnedProgramError) => {
        options.onDrainFailure?.(failure)
        this.settle()?.reject(failure)
        if (!this.closed) {
          this.closed = true
          this.kill()
        }
        release()
        throw failure
      },
    )
    void this.drained.catch(() => undefined)
    // A missing PID only tells us to wait for the producer's classification.
    // Install the child and stdio observers above even for this launch path.
    if (windows && child.pid === undefined) {
      this.startup = joined.then(({ ownership, error }) =>
        ownership === 'not-started' ? (error ?? new Error('Pi RPC did not start')) : null,
      )
      void this.startup.catch(() => undefined)
    }
  }

  prompt(message: string): Promise<PiRunResult> {
    if (!this.isAlive || this.active)
      return Promise.reject(new Error('Pi RPC run is not available for another turn'))
    this.settled = false
    this.active = true
    this.started = false
    this.lastError = undefined
    // A late acknowledgement for the last turn cannot settle this one.
    this.commands.clear()
    // Each turn's result is that turn's answer, not every answer so far.
    this.output = ''
    this.phase = this.configuredModel === undefined || this.modelSet ? 'prompt' : 'setting-model'
    const result = new Promise<PiRunResult>((resolve, reject) => {
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
    return result
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
    try {
      if (!this.windowsExitKnown) this.send({ type: 'abort' })
    } catch {
      /* process may already be closing */
    }
    this.closed = true
    this.finish({ status: 'aborted', output: this.output })
    this.kill()
    return this.drained
  }

  close(): Promise<void> {
    if (this.closed) return this.drained
    this.closed = true
    if (this.active) this.finish({ status: 'aborted', output: this.output })
    this.kill()
    return this.drained
  }

  private kill(): void {
    // Only the launch adapter owns the original native handle and escalation.
    if (this.windowsExitKnown || this.child.pid === undefined) return
    try {
      this.child.kill('SIGTERM')
    } catch {
      /* the join retains proof failure */
    }
  }

  private requireActive(): void {
    if (!this.isAlive) throw new Error('Pi RPC process exited before the follow-up')
    if (!this.active || this.settled) throw new Error('Pi RPC run is not active')
  }

  private send(command: Record<string, unknown>): string {
    const id = `holi-${++this.requestId}`
    const stdin = this.child.stdin
    if (!stdin) throw new Error('Pi RPC stdin is unavailable')
    this.commands.set(id, {
      type: String(command.type),
      ...(command.streamingBehavior === undefined
        ? {}
        : { streamingBehavior: command.streamingBehavior }),
    })
    stdin.write(`${JSON.stringify({ id, ...command })}\n`, (error?: Error | null) => {
      if (error) this.fail(error.message)
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
      if (Buffer.byteLength(line) > this.maxLineBytes) {
        this.badRecord()
        continue
      }
      try {
        const record = JSON.parse(line) as Record<string, unknown>
        if (this.windowsExitKnown && typeof record?.type !== 'string') this.badRecord()
        else this.onRecord(record)
      } catch {
        this.badRecord()
      }
    }
  }

  private badRecord(): void {
    if (this.windowsExitKnown) this.fail('Malformed Pi RPC record at exit')
    else if (++this.parseErrors >= 10) this.fail('Too many malformed Pi RPC records')
  }

  private onRecord(record: Record<string, unknown>): void {
    if (record.type === 'response') {
      const id = typeof record.id === 'string' ? record.id : undefined
      const request = id === undefined ? undefined : this.commands.get(id)
      if (id === undefined || request === undefined) return
      this.commands.delete(id)
      const command = request.type
      if (command === 'get_session_stats') {
        // Even an unsuccessful stats response releases a pending settlement.
        this.publish(() => this.onStatsResponse(record))
        return
      }
      if (record.success === false) {
        this.fail(String(record.error ?? `Pi rejected ${command ?? 'command'}`))
        return
      }
      if (command === 'set_model') {
        if (this.windowsExitKnown) return
        this.modelSet = true
        if (this.phase === 'setting-model' && this.pendingPrompt !== undefined) {
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
          const result: PiRunResult = {
            status: 'completed',
            output: this.output,
            model: this.model,
            usage: this.usage,
          }
          this.publish(() => this.finish(result))
        }
      }
      return
    }
    if (record.type === 'agent_start') {
      this.active = true
      this.started = true
    }
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
      if (this.settled || this.statsPending || this.exitSettlementQueued) return
      const result: PiRunResult = {
        status: record.aborted === true ? 'aborted' : this.lastError ? 'failed' : 'completed',
        output: this.output,
        ...(this.lastError === undefined ? {} : { error: this.lastError }),
        model: this.model,
        usage: this.usage,
      }
      this.exitSettlementQueued = this.windowsExitKnown
      this.publish(() => this.onAgentSettled(result))
    }
  }

  private publish(publication: () => void): void {
    // Snapshot terminal events at their original position in the stream and
    // consume response IDs on arrival. Progress can continue while these wait.
    if (this.exitError !== undefined) return
    if (this.windowsExitKnown && !this.exitVerified) this.exitPublications.push(publication)
    else publication()
  }

  private flushExitPublications(): void {
    for (const publication of this.exitPublications) {
      if (this.closed) return
      try {
        publication()
      } catch {
        this.badRecord()
        return
      }
    }
    // A live settlement may have been waiting for optional stats when Pi exited.
    if (this.statsPending && this.exitError === undefined) this.finish(this.statsPending)
  }

  private onAgentSettled(result: PiRunResult): void {
    if (this.settled) return
    if (!this.closed && !this.windowsExitKnown && this.onStats) {
      try {
        this.statsPending = result
        const id = this.send({ type: 'get_session_stats' })
        if (this.statsPending !== result || this.windowsExitKnown) return
        this.statsTimer = setTimeout(() => {
          this.statsTimer = undefined
          if (this.windowsExitKnown) return
          this.commands.delete(id)
          this.finish(result)
        }, 1000)
        return
      } catch {
        // Completion does not depend on optional usage data.
      }
    }
    this.publish(() => this.finish(result))
  }

  private onStatsResponse(record: Record<string, unknown>): void {
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
    const result = this.statsPending
    if (result) this.publish(() => this.finish(result))
  }

  private append(text: string): void {
    const room = this.maxOutputBytes - Buffer.byteLength(this.output)
    if (room > 0) this.output += Buffer.from(text).subarray(0, room).toString()
  }

  private fail(error: string): void {
    if (this.closed) return
    if (this.windowsExitKnown) {
      // Retain the first turn error, but let an unconfirmed join reject the
      // pending prompt with the original ownership failure and cleanup lease.
      this.exitError ??= error
      this.exitPublications.length = 0
      return
    }
    this.finish({ status: 'failed', output: this.output, error })
    this.closed = true
    this.kill()
  }

  private clearStatsTimer(): void {
    clearTimeout(this.statsTimer)
    this.statsTimer = undefined
  }

  private settle() {
    if (this.settled) return
    this.clearStatsTimer()
    this.statsPending = undefined
    this.settled = true
    this.active = false
    this.phase = 'idle'
    this.pendingPrompt = undefined
    const completion = this.completion
    this.completion = undefined
    return completion
  }

  private finish(result: PiRunResult): void {
    this.settle()?.resolve({
      ...result,
      model: result.model ?? this.model,
      usage: result.usage ?? this.usage,
    })
  }
}
