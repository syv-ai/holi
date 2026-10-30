import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

type PiRunStatus = 'working' | 'completed' | 'failed' | 'aborted'
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
  spawn?: (
    bin: string,
    args: string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv; stdio: 'pipe' },
  ) => PiChild
}
export interface PiChild {
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
  private readonly configuredModel?: { provider: string; modelId: string }
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
  private phase: 'prompt' | 'setting-model' | 'idle' = 'idle'
  private readonly commands = new Map<string, string>()

  constructor(options: PiRpcOptions) {
    this.maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024
    this.maxLineBytes = options.maxLineBytes ?? 1024 * 1024
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
      ((bin, args, opts) => nodeSpawn(bin, args, opts) as ChildProcessWithoutNullStreams)
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
    this.phase = this.configuredModel === undefined ? 'prompt' : 'setting-model'
    this.resultPromise = new Promise((resolve) => {
      this.completion = resolve
    })
    try {
      if (this.configuredModel) {
        this.send({ type: 'set_model', ...this.configuredModel })
      } else this.sendPrompt(message)
      this.pendingPrompt = this.configuredModel === undefined ? undefined : message
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
    try {
      this.child.kill('SIGTERM')
    } catch {
      /* already exited */
    }
  }

  private requireActive(): void {
    if (!this.active || this.settled) throw new Error('Pi RPC run is not active')
  }

  private send(command: Record<string, unknown>): void {
    const id = `holi-${++this.requestId}`
    this.commands.set(id, String(command.type))
    this.child.stdin.write(`${JSON.stringify({ id, ...command })}\n`)
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
      if (record.success === false) {
        this.fail(String(record.error ?? `Pi rejected ${command ?? 'command'}`))
        return
      }
      if (command === 'set_model') {
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
      }
    }
    if (record.type === 'agent_settled') {
      this.finish({
        status: record.aborted === true ? 'aborted' : 'completed',
        output: this.output,
        model: this.model,
        usage: this.usage,
      })
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
