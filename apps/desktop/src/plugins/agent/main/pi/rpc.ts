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
  private model?: unknown
  private usage?: unknown

  constructor(options: PiRpcOptions) {
    this.maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024
    this.maxLineBytes = options.maxLineBytes ?? 1024 * 1024
    const spawn =
      options.spawn ??
      ((bin, args, opts) => nodeSpawn(bin, args, opts) as ChildProcessWithoutNullStreams)
    this.child = spawn(options.bin, ['--mode', 'rpc'], {
      cwd: options.cwd,
      env: options.env,
      stdio: 'pipe',
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.consume(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', () => {})
    this.child.once('error', (error) =>
      this.finish({ status: 'failed', output: this.output, error: error.message }),
    )
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
    if (this.settled || this.active) return Promise.reject(new Error('Pi RPC run is not idle'))
    this.active = true
    this.resultPromise = new Promise((resolve) => {
      this.completion = resolve
    })
    this.send({ type: 'prompt', message })
    return this.resultPromise
  }

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
    if (this.settled) return
    try {
      this.send({ type: 'abort' })
    } catch {
      /* process may already be closing */
    }
    this.finish({ status: 'aborted', output: this.output })
    this.child.kill('SIGTERM')
  }

  close(): void {
    if (this.settled) return
    this.finish({ status: 'aborted', output: this.output })
    this.child.kill('SIGTERM')
  }

  private requireActive(): void {
    if (!this.active || this.settled) throw new Error('Pi RPC run is not active')
  }

  private send(command: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ id: `holi-${++this.requestId}`, ...command })}\n`)
  }

  private consume(chunk: string): void {
    this.pending += chunk
    if (Buffer.byteLength(this.pending) > this.maxLineBytes && !this.pending.includes('\n')) {
      this.pending = ''
      this.finish({
        status: 'failed',
        output: this.output,
        error: 'Pi RPC emitted an oversized record',
      })
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
    this.parseErrors++
    if (this.parseErrors >= 10)
      this.finish({
        status: 'failed',
        output: this.output,
        error: 'Too many malformed Pi RPC records',
      })
  }

  private onRecord(record: Record<string, unknown>): void {
    if (record.type === 'response' && record.command === 'prompt') {
      if (record.success === false) {
        this.finish({
          status: 'failed',
          output: this.output,
          error: String(record.error ?? 'Pi rejected prompt'),
        })
      } else if (
        (record.data as { disposition?: unknown } | undefined)?.disposition === 'handled'
      ) {
        this.finish({ status: 'completed', output: this.output })
      }
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
      const aborted = record.aborted === true
      this.finish({
        status: aborted ? 'aborted' : 'completed',
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

  private finish(result: PiRunResult): void {
    if (this.settled) return
    this.settled = true
    this.completion?.({
      ...result,
      model: result.model ?? this.model,
      usage: result.usage ?? this.usage,
    })
    this.child.kill('SIGTERM')
  }
}
