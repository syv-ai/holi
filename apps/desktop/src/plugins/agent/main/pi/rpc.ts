import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

type PiRunStatus = 'completed' | 'failed' | 'aborted'
export interface PiRunResult {
  status: PiRunStatus
  output: string
  error?: string
  usage?: unknown
  model?: unknown
}
export interface PiRpcOptions {
  bin: string
  cwd: string
  env?: NodeJS.ProcessEnv
  model?: string
  system?: string
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
  stdin: Writable
  stdout: Readable
  stderr: Readable
  once(event: 'error', listener: (error: Error) => void): this
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  kill(signal?: NodeJS.Signals): boolean
}

/** One stock Pi RPC process per managed run; messages are JSON records, never shell text. */
export class PiRpcRun {
  private readonly child: PiChild
  private readonly onStats?: PiRpcOptions['onStats']
  private readonly processGroup: boolean
  private exited = false
  private killTimer?: ReturnType<typeof setTimeout>
  private statsTimer?: ReturnType<typeof setTimeout>
  private statsPending?: PiRunResult
  private readonly configuredModel?: { provider: string; modelId: string }
  private modelSet = false
  private pending = ''
  private output = ''
  private parseErrors = 0
  private settled = false
  private active = false
  private requestId = 0
  private readonly maxOutputBytes: number
  private readonly maxLineBytes: number
  private completion?: (result: PiRunResult) => void
  private resultPromise?: Promise<PiRunResult>
  private closed = false
  private model?: unknown
  private usage?: unknown
  private lastError?: string
  private phase: 'prompt' | 'setting-model' | 'idle' = 'idle'
  private readonly commands = new Map<string, string>()

  constructor(options: PiRpcOptions) {
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
    this.processGroup = options.spawn === undefined && process.platform !== 'win32'
    const spawn =
      options.spawn ??
      ((bin, args, opts) =>
        nodeSpawn(bin, args, {
          ...opts,
          detached: this.processGroup,
        }) as ChildProcessWithoutNullStreams)
    const args = ['--mode', 'rpc']
    if (options.system !== undefined) args.push('--append-system-prompt', options.system)
    this.child = spawn(options.bin, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'pipe',
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.consume(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', () => {})
    this.child.once('error', (error) => {
      this.finish({ status: 'failed', output: this.output, error: error.message })
      this.kill()
    })
    this.child.once('exit', (code, signal) => {
      this.exited = true
      // Pi can exit while a tool it started still holds the process group.
      // Keep the escalation timer for the entire group, not just its leader.
      if (this.killTimer && !this.processGroup) clearTimeout(this.killTimer)
      if (!this.settled)
        this.finish({
          status: 'failed',
          output: this.output,
          error: `Pi RPC exited (${code ?? signal ?? 'unknown'})`,
        })
    })
  }

  prompt(message: string): Promise<PiRunResult> {
    if (this.closed || this.active) return Promise.reject(new Error('Pi RPC run is not idle'))
    this.settled = false
    this.active = true
    this.lastError = undefined
    this.phase = this.configuredModel === undefined || this.modelSet ? 'prompt' : 'setting-model'
    this.resultPromise = new Promise((resolve) => {
      this.completion = resolve
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
    this.send({ type: 'prompt', message, streamingBehavior: 'followUp' })
  }

  cancel(): void {
    if (this.closed) return
    try {
      this.send({ type: 'abort' })
    } catch {
      /* process may already be closing */
    }
    this.closed = true
    this.finish({ status: 'aborted', output: this.output })
    this.kill()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.active) this.finish({ status: 'aborted', output: this.output })
    this.kill()
  }

  private kill(): void {
    const signal = (name: NodeJS.Signals) => {
      if (this.exited && !this.processGroup) return
      try {
        if (this.processGroup && this.child.pid !== undefined) process.kill(-this.child.pid, name)
        else if (!this.exited) this.child.kill(name)
      } catch {
        /* process or its group already exited */
      }
    }
    signal('SIGTERM')
    if (!this.killTimer && (!this.exited || this.processGroup)) {
      this.killTimer = setTimeout(() => {
        this.killTimer = undefined
        signal('SIGKILL')
      }, 1500)
      this.killTimer.unref()
    }
  }

  private requireActive(): void {
    if (!this.active || this.settled) throw new Error('Pi RPC run is not active')
  }

  private send(command: Record<string, unknown>): string {
    const id = `holi-${++this.requestId}`
    this.commands.set(id, String(command.type))
    this.child.stdin.write(`${JSON.stringify({ id, ...command })}\n`)
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
        this.onRecord(JSON.parse(line) as Record<string, unknown>)
      } catch {
        this.badRecord()
      }
    }
  }

  private badRecord(): void {
    if (++this.parseErrors >= 10) this.fail('Too many malformed Pi RPC records')
  }

  private onRecord(record: Record<string, unknown>): void {
    if (record.type === 'response') {
      const id = typeof record.id === 'string' ? record.id : undefined
      const command = id === undefined ? undefined : this.commands.get(id)
      if (id !== undefined) this.commands.delete(id)
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
        if (this.statsPending) this.finish(this.statsPending)
        return
      }
      if (record.success === false) {
        this.fail(String(record.error ?? `Pi rejected ${command ?? 'command'}`))
        return
      }
      if (command === 'set_model') {
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
        if (disposition === 'handled') {
          this.finish({
            status: 'completed',
            output: this.output,
            model: this.model,
            usage: this.usage,
          })
        } else if (disposition === 'followUp' && record.success !== true) {
          this.fail('Pi could not queue the follow-up prompt')
        }
      }
      return
    }
    if (record.type === 'agent_start') this.active = true
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
      if (this.settled || this.statsPending) return
      const result: PiRunResult = {
        status: record.aborted === true ? 'aborted' : this.lastError ? 'failed' : 'completed',
        output: this.output,
        ...(this.lastError === undefined ? {} : { error: this.lastError }),
        model: this.model,
        usage: this.usage,
      }
      if (!this.closed && this.onStats) {
        try {
          this.statsPending = result
          const id = this.send({ type: 'get_session_stats' })
          this.statsTimer = setTimeout(() => {
            this.commands.delete(id)
            this.finish(result)
          }, 1000)
          return
        } catch {
          // Completion does not depend on optional usage data.
        }
      }
      this.finish(result)
    }
  }

  private append(text: string): void {
    const room = this.maxOutputBytes - Buffer.byteLength(this.output)
    if (room > 0) this.output += Buffer.from(text).subarray(0, room).toString()
  }

  private fail(error: string): void {
    this.finish({ status: 'failed', output: this.output, error })
    this.closed = true
    this.kill()
  }

  private finish(result: PiRunResult): void {
    if (this.settled) return
    if (this.statsTimer) clearTimeout(this.statsTimer)
    this.statsTimer = undefined
    this.statsPending = undefined
    this.settled = true
    this.active = false
    this.phase = 'idle'
    this.pendingPrompt = undefined
    const completion = this.completion
    this.completion = undefined
    completion?.({
      ...result,
      model: result.model ?? this.model,
      usage: result.usage ?? this.usage,
    })
  }
}
