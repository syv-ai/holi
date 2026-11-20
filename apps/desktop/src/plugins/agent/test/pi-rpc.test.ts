import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UnconfirmedOwnedProgramError, type OwnedCompletion } from '../../../main/plugin-api'
import { PiRpcRun, type PiRpcOptions } from '../main/pi/rpc'

function fake(autoClose = true) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const commands: Record<string, unknown>[] = []
  stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().trim().split('\n'))
      if (line) commands.push(JSON.parse(line) as Record<string, unknown>)
  })
  const child = Object.assign(new ChildProcess(), {
    stdin,
    stdout,
    stderr,
    kill: vi.fn(() => {
      child.emit('exit', null, 'SIGTERM')
      if (autoClose) close()
      return true
    }),
  })
  function close(code: number | null = null) {
    stdout.end()
    stderr.end()
    child.emit('close', code, null)
  }
  return {
    child,
    stdout,
    stderr,
    commands,
    exit: () => {
      child.emit('exit', 1, null)
      close(1)
    },
    error: (error: Error) => child.emit('error', error),
    close,
  }
}

function createRun(options: PiRpcOptions) {
  return new PiRpcRun({ platform: 'linux', ...options })
}

function windowsRun(
  rpc: ReturnType<typeof fake>,
  ownedCompletion: Promise<OwnedCompletion>,
  onStats?: PiRpcOptions['onStats'],
) {
  const child = Object.assign(rpc.child, { pid: 43210, ownedCompletion })
  return createRun({ bin: 'pi', cwd: '/vault-a', platform: 'win32', spawn: () => child, onStats })
}

function deferredReceipt() {
  let resolve!: (value: OwnedCompletion) => void
  let reject!: (error: Error) => void
  const promise = new Promise<OwnedCompletion>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function writeRecords(rpc: ReturnType<typeof fake>, ...records: Record<string, unknown>[]) {
  rpc.stdout.write(records.map((record) => JSON.stringify(record) + '\n').join(''))
}

const agentSettled = { type: 'agent_settled', aborted: false }
const handled = (id: unknown) => ({
  type: 'response',
  id,
  success: true,
  data: { disposition: 'handled' },
})
const text = (delta: string) => ({
  type: 'message_update',
  assistantMessageEvent: { type: 'text_delta', delta },
})

afterEach(() => vi.useRealTimers())

describe('PiRpcRun', () => {
  it('joins Windows EMPTY and actual output settlement, not child close alone', async () => {
    const rpc = fake(false)
    let resolveProof!: (result: OwnedCompletion) => void
    const receipt = new Promise<OwnedCompletion>((resolve) => (resolveProof = resolve))
    const run = windowsRun(rpc, receipt)
    const closing = run.close()
    expect(run.close()).toBe(closing)
    const settled = vi.fn()
    void closing.then(settled)
    rpc.child.emit('close', 0, null)
    rpc.stdout.emit('end')
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    resolveProof('empty')
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    rpc.stderr.emit('end')
    await expect(closing).resolves.toBeUndefined()
    rpc.close()
  })

  it('rejects a known Windows proof failure while close and stdio are held', async () => {
    vi.useFakeTimers()
    const rpc = fake(false)
    let rejectProof!: (error: Error) => void
    const receipt = new Promise<OwnedCompletion>((_resolve, reject) => (rejectProof = reject))
    const run = windowsRun(rpc, receipt)
    const closing = run.close()
    const failure = new UnconfirmedOwnedProgramError(new Error('helper query failed'), {
      revoke: vi.fn(async () => {}),
    })
    rejectProof(failure)
    await expect(closing).rejects.toBe(failure)
    expect(rpc.stdout.destroyed).toBe(false)
    expect(rpc.stderr.destroyed).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    for (let i = 0; i < 20; i++) {
      expect(run.close()).toBe(closing)
      expect(run.cancel()).toBe(closing)
    }
    expect(rpc.child.listenerCount('close')).toBe(0)
    expect(rpc.child.listenerCount('exit')).toBe(0)
    expect(rpc.stdout.listenerCount('data')).toBe(0)
    expect(rpc.stdout.listenerCount('error')).toBe(1)
    expect(rpc.stderr.listenerCount('error')).toBe(1)
    // Late teardown errors do not replace the original failure or go unhandled.
    rpc.stdout.emit('error', new Error('late pipe error'))
    await expect(run.drained).rejects.toBe(failure)
    rpc.close()
  })

  it.each(['stdout', 'stderr'] as const)(
    'records a Windows %s error without counting it as closure',
    async (stream) => {
      const rpc = fake(false)
      const run = windowsRun(rpc, Promise.resolve('empty'))
      const result = run.prompt('x')
      rpc[stream].emit('error', new Error(`${stream} read failed`))
      await expect(result).resolves.toMatchObject({
        status: 'failed',
        error: `${stream} read failed`,
      })
      const settled = vi.fn()
      void run.drained.then(settled)
      rpc[stream === 'stdout' ? 'stderr' : 'stdout'].emit('end')
      await Promise.resolve()
      expect(settled).not.toHaveBeenCalled()
      rpc[stream].destroy()
      await expect(run.drained).resolves.toBeUndefined()
      rpc.close()
    },
  )

  it('holds a buffered settlement and handled response, then rejects with the original proof failure', async () => {
    vi.useFakeTimers()
    const rpc = fake(false)
    const receipt = deferredReceipt()
    const onStats = vi.fn()
    const run = windowsRun(rpc, receipt.promise, onStats)
    const result = run.prompt('go')
    const completed = vi.fn()
    const rejected = vi.fn()
    void result.then(completed, rejected)
    rpc.child.emit('exit', 0, null)
    writeRecords(rpc, text('answer'), agentSettled, handled(rpc.commands[0]!.id), agentSettled)
    await vi.advanceTimersByTimeAsync(1001)
    expect(completed).not.toHaveBeenCalled()
    expect(rejected).not.toHaveBeenCalled()
    expect(onStats).not.toHaveBeenCalled()
    // Dispatching agent_settled itself would request stats, even if the prompt
    // promise were separately fenced.
    expect(rpc.commands.map(({ type }) => type)).toEqual(['prompt'])

    const cause = new Error('helper query failed')
    const lease = { revoke: vi.fn(async () => {}) }
    const failure = new UnconfirmedOwnedProgramError(cause, lease)
    receipt.reject(failure)
    await expect(run.drained).rejects.toBe(failure)
    await expect(result).rejects.toBe(failure)
    expect(rejected).toHaveBeenCalledExactlyOnceWith(failure)
    expect(failure).toMatchObject({ cause, lease })
    expect(rpc.stdout.readableEnded).toBe(false)
    writeRecords(rpc, agentSettled, handled(rpc.commands[0]!.id))
    expect(completed).not.toHaveBeenCalled()
    expect(onStats).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(rpc.child.kill).not.toHaveBeenCalled()
    rpc.close()
  })

  it.each(['event', 'response'] as const)(
    'publishes the first buffered %s once, only after the full clean join',
    async (first) => {
      vi.useFakeTimers()
      const rpc = fake(false)
      const receipt = deferredReceipt()
      const onStats = vi.fn()
      const run = windowsRun(rpc, receipt.promise, onStats)
      const result = run.prompt('go')
      const prompt = rpc.commands[0]!
      run.followUp('queued')
      const followUp = rpc.commands[1]!
      const completed = vi.fn()
      void result.then(completed)
      const records = [agentSettled, handled(prompt.id)]
      if (first === 'response') records.reverse()

      // Node assigns exitCode first. The earlier exit listener flushes stdout
      // before Pi or the join receives its exit notification.
      rpc.child.prependOnceListener('exit', () => {
        writeRecords(
          rpc,
          handled(followUp.id),
          text('answer'),
          records[0]!,
          text(' too late'),
          records[1]!,
          ...records,
        )
      })
      Object.assign(rpc.child, { exitCode: 0 })
      rpc.child.emit('exit', 0, null)
      await vi.advanceTimersByTimeAsync(0)
      expect(completed).not.toHaveBeenCalled()
      expect(rpc.commands.map(({ type }) => type)).toEqual(['prompt', 'prompt'])

      receipt.resolve('empty')
      rpc.stdout.end()
      await vi.advanceTimersByTimeAsync(1001)
      expect(completed).not.toHaveBeenCalled()
      expect(onStats).not.toHaveBeenCalled()
      rpc.stderr.end()
      await run.drained
      expect(completed).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ status: 'completed', output: 'answer' }),
      )
      expect(vi.getTimerCount()).toBe(0)
      rpc.child.emit('close', 0, null)
    },
  )

  it.each([
    ['stdio error', /late read failure/],
    ['missing EOF', /stdout closed before end/],
    ['malformed JSONL', /malformed Pi RPC record/i],
    ['truncated JSONL', /incomplete Pi RPC record/i],
  ] as const)('discards buffered success on %s even after EMPTY', async (issue, expected) => {
    vi.useFakeTimers()
    const rpc = fake(false)
    const receipt = deferredReceipt()
    const run = windowsRun(rpc, receipt.promise)
    const result = run.prompt('go')
    const settled = vi.fn()
    void result.then(settled)
    rpc.child.emit('exit', 0, null)
    writeRecords(rpc, handled(rpc.commands[0]!.id), agentSettled)
    rpc.child.emit('close', 0, null)
    receipt.resolve('empty')
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).not.toHaveBeenCalled()

    if (issue === 'stdio error') {
      rpc.stderr.emit('error', new Error('late read failure'))
      rpc.stdout.emit('error', new Error('another read failure'))
    }
    if (issue === 'malformed JSONL') rpc.stdout.write('not-json\n')
    if (issue === 'truncated JSONL') rpc.stdout.write('{"type":')
    if (issue === 'missing EOF') {
      rpc.stdout.destroy()
      await vi.advanceTimersByTimeAsync(0)
      rpc.stderr.emit('error', new Error('later than the premature stdout close'))
    } else rpc.stdout.end()
    rpc.stderr.end()
    await expect(result).resolves.toMatchObject({ status: 'failed', error: expected })
    await expect(run.drained).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([true, false])(
    'joins a live settlement still waiting on stats (response: %s)',
    async (respond) => {
      vi.useFakeTimers()
      const rpc = fake(false)
      const receipt = deferredReceipt()
      const onStats = vi.fn()
      const run = windowsRun(rpc, receipt.promise, onStats)
      const result = run.prompt('go')
      const completed = vi.fn()
      void result.then(completed)
      writeRecords(rpc, text('first'), agentSettled)
      const stats = rpc.commands.at(-1)!
      expect(stats.type).toBe('get_session_stats')

      rpc.child.emit('exit', 0, null)
      if (respond) {
        const response = { type: 'response', id: stats.id, success: true, data: { cost: 1 } }
        writeRecords(rpc, response, response, agentSettled)
      }
      expect(vi.getTimerCount()).toBe(1) // Only the existing join's output deadline.
      await vi.advanceTimersByTimeAsync(1001)
      expect(onStats).not.toHaveBeenCalled()
      expect(completed).not.toHaveBeenCalled()
      receipt.resolve('empty')
      rpc.close(0)
      await run.drained
      expect(completed).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ status: 'completed', output: 'first' }),
      )
      expect(onStats).toHaveBeenCalledTimes(respond ? 1 : 0)
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('publishes live Windows turns without waiting for exit, EMPTY, or EOF', async () => {
    const rpc = fake(false)
    const receipt = deferredReceipt()
    const run = windowsRun(rpc, receipt.promise)
    const first = run.prompt('first')
    const oldPrompt = rpc.commands[0]!
    writeRecords(rpc, text('first answer'), agentSettled)
    await expect(first).resolves.toMatchObject({ status: 'completed', output: 'first answer' })
    expect(run.isAlive).toBe(true)

    const second = run.prompt('second')
    writeRecords(rpc, handled(oldPrompt.id), text('second answer'), agentSettled)
    await expect(second).resolves.toMatchObject({ status: 'completed', output: 'second answer' })
    expect(run.isAlive).toBe(true)
    rpc.child.emit('exit', 0, null)
    rpc.close(0)
    receipt.resolve('empty')
    await run.drained
  })

  it('settles close without end as an output failure with confirmed Windows cleanup', async () => {
    const rpc = fake(false)
    const run = windowsRun(rpc, Promise.resolve('empty'))
    const result = run.prompt('go')
    rpc.child.emit('exit', 0, null)
    rpc.stdout.destroy()
    rpc.stderr.end()
    await expect(result).resolves.toMatchObject({
      status: 'failed',
      error: /stdout closed before end/,
    })
    await expect(run.drained).resolves.toBeUndefined()
  })

  it.each([
    [37, null],
    [null, 'SIGTERM'],
  ] as const)(
    'discards a buffered Windows settlement after exit (%s, %s)',
    async (code, signal) => {
      const rpc = fake(false)
      const run = windowsRun(rpc, Promise.resolve('empty'))
      const result = run.prompt('go')
      rpc.child.prependOnceListener('exit', () => writeRecords(rpc, agentSettled))
      Object.assign(rpc.child, { exitCode: code, signalCode: signal })
      rpc.child.emit('exit', code, signal)
      rpc.stdout.end()
      rpc.stderr.end()
      await expect(result).resolves.toMatchObject({
        status: 'failed',
        error: `Pi RPC exited (${code ?? signal})`,
      })
      await expect(run.close()).resolves.toBeUndefined()
    },
  )

  it('bounds held Windows output without installing a new join for each close', async () => {
    vi.useFakeTimers()
    const rpc = fake(false)
    const run = windowsRun(rpc, Promise.resolve('empty'))
    const result = run.prompt('x')
    rpc.child.emit('exit', 0, null)
    const settled = vi.fn()
    void run.drained.then(settled)
    await vi.advanceTimersByTimeAsync(4999)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(result).resolves.toMatchObject({
      status: 'failed',
      error: /stdout did not settle/,
    })
    for (let i = 0; i < 20; i++) expect(run.close()).toBe(run.drained)
    expect(rpc.stdout.destroyed).toBe(true)
    expect(rpc.stderr.destroyed).toBe(true)
    expect(rpc.stdout.listenerCount('end')).toBe(0)
    expect(rpc.stdout.listenerCount('close')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps POSIX child close semantics without waiting for either stream to end', async () => {
    const rpc = fake(false)
    const run = createRun({ bin: 'pi', cwd: '/v', spawn: () => rpc.child })
    const settled = vi.fn()
    void run.close().then(settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    rpc.child.emit('close', null, 'SIGTERM')
    await expect(run.drained).resolves.toBeUndefined()
    expect(rpc.stdout.readableEnded).toBe(false)
    expect(rpc.stderr.readableEnded).toBe(false)
    rpc.close()
  })

  it('uses one RPC process, frames commands and waits for agent_settled', async () => {
    const fakeProcess = fake()
    const run = createRun({
      bin: '/pi path/pi',
      cwd: '/vault',
      spawn: (_bin, args, opts) => {
        expect(args).toEqual(['--mode', 'rpc'])
        expect(opts.cwd).toBe('/vault')
        return fakeProcess.child
      },
    })
    const resultPromise = run.prompt('Review this')
    run.steer('Keep this in mind')
    run.followUp('Then summarize')
    fakeProcess.stdout.write(
      '{"type":"agent_end"}\n{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"done"}}\n',
    )
    let resolved = false
    void resultPromise.then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false)
    fakeProcess.stdout.write(
      '{"type":"message_end","message":{"role":"assistant","model":"m","usage":{"totalTokens":4}}}\n{"type":"agent_settled","aborted":false}\n',
    )
    await expect(resultPromise).resolves.toMatchObject({
      status: 'completed',
      output: 'done',
      model: 'm',
      usage: { totalTokens: 4 },
    })
    expect(fakeProcess.commands.map((c) => c.type)).toEqual(['prompt', 'prompt', 'prompt'])
    expect(fakeProcess.commands[1]).toMatchObject({ streamingBehavior: 'steer' })
    expect(fakeProcess.commands[2]).toMatchObject({ streamingBehavior: 'followUp' })
  })

  it('replays a constructed attributed RPC transcript across fragmented JSONL chunks', async () => {
    // Constructed consumer fixture from Pi docs/rpc.md and src/modes/rpc/rpc-types.ts
    // at upstream revision b4899f59ef0fba6507c2e619fd804dcde51920ba; not captured
    // from that release and not evidence of producer emission.
    const process = fake()
    const run = createRun({
      bin: 'pi',
      cwd: '/empty-workdir',
      model: 'provider/model-id',
      spawn: () => process.child,
    })
    const result = run.prompt('first prompt')
    const modelCommand = process.commands[0]!
    expect(modelCommand).toMatchObject({
      type: 'set_model',
      provider: 'provider',
      modelId: 'model-id',
    })
    process.stdout.write(`{"type":"response","id":"${modelCommand.id}","success":true}`)
    process.stdout.write(
      '\n{"type":"agent_start"}\n{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hello"}}',
    )
    process.stdout.write(
      '\n{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":" world"}}\n{"type":"agent_end"}\n',
    )
    let settled = false
    void result.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    process.stdout.write('{"type":"agent_settled","aborted":false}\n')
    await expect(result).resolves.toMatchObject({ status: 'completed', output: 'hello world' })
  })

  it('keeps ordinary acknowledgements and agent_end pending until settlement', async () => {
    const process = fake()
    const run = createRun({ bin: 'pi', cwd: '/v', spawn: () => process.child })
    const result = run.prompt('go')
    process.stdout.write(
      `{"type":"response","id":"${process.commands[0]!.id}","success":true}\n{"type":"agent_end"}\n`,
    )
    let completed = false
    void result.then(() => {
      completed = true
    })
    await Promise.resolve()
    expect(completed).toBe(false)
    process.stdout.write('{"type":"agent_settled","aborted":false}\n')
    await expect(result).resolves.toMatchObject({ status: 'completed' })
  })

  it('rejects a follow-up when the RPC process exited between turns', async () => {
    const process = fake()
    const run = createRun({ bin: 'pi', cwd: '/v', spawn: () => process.child })
    const first = run.prompt('first')
    process.stdout.write('{"type":"agent_settled","aborted":false}\n')
    await expect(first).resolves.toMatchObject({ status: 'completed' })
    process.exit()
    expect(() => run.followUp('second')).toThrow(/process exited/)
  })

  it('bounds output and returns failed on malformed input limit', async () => {
    const fakeProcess = fake()
    const run = createRun({
      bin: 'pi',
      cwd: '/v',
      maxOutputBytes: 3,
      maxLineBytes: 128,
      spawn: () => fakeProcess.child,
    })
    const result = run.prompt('x')
    fakeProcess.stdout.write(
      '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"long"}}\n',
    )
    fakeProcess.stdout.write('1'.repeat(129))
    await expect(result).resolves.toMatchObject({ status: 'failed', output: 'lon' })
  })

  it('fails after repeated malformed records without treating one bad line as settlement', async () => {
    const process = fake()
    const run = createRun({ bin: 'pi', cwd: '/v', spawn: () => process.child })
    const result = run.prompt('go')
    process.stdout.write('not-json\n'.repeat(9))
    let completed = false
    void result.then(() => {
      completed = true
    })
    await Promise.resolve()
    expect(completed).toBe(false)
    process.stdout.write('still-not-json\n')
    await expect(result).resolves.toMatchObject({ status: 'failed', error: /malformed/ })
  })

  it.each(['steer', 'followUp'] as const)(
    'does not let a handled queued %s settle the active turn before agent_start',
    async (kind) => {
      const process = fake()
      const run = createRun({ bin: 'pi', cwd: '/v', spawn: () => process.child })
      const result = run.prompt('active')
      run[kind]('queued')
      const queued = process.commands.at(-1)!
      process.stdout.write(
        JSON.stringify({
          type: 'response',
          id: queued.id,
          command: 'prompt',
          success: true,
          data: { disposition: 'handled' },
        }) + '\n',
      )
      let completed = false
      void result.then(() => {
        completed = true
      })
      await Promise.resolve()
      expect(completed).toBe(false)
      process.stdout.write('{"type":"agent_start"}\n')
      process.stdout.write('{"type":"agent_settled","aborted":false}\n')
      await expect(result).resolves.toMatchObject({ status: 'completed' })
    },
  )

  it('does not let a handled queued steer settle the active turn after agent_start', async () => {
    const process = fake()
    const run = createRun({ bin: 'pi', cwd: '/v', spawn: () => process.child })
    const result = run.prompt('active')
    process.stdout.write('{"type":"agent_start"}\n')
    run.steer('queued')
    const queued = process.commands.at(-1)!
    process.stdout.write(
      JSON.stringify({
        type: 'response',
        id: queued.id,
        command: 'prompt',
        success: true,
        data: { disposition: 'handled' },
      }) + '\n',
    )
    let completed = false
    void result.then(() => {
      completed = true
    })
    await Promise.resolve()
    expect(completed).toBe(false)
    process.stdout.write('{"type":"agent_settled","aborted":false}\n')
    await expect(result).resolves.toMatchObject({ status: 'completed' })
  })

  it('completes a handled no-run prompt and reuses the process', async () => {
    const fakeProcess = fake()
    const run = createRun({ bin: 'pi', cwd: '/v', spawn: () => fakeProcess.child })
    const result = run.prompt('/handled')
    const prompt = fakeProcess.commands[0]!
    fakeProcess.stdout.write(
      JSON.stringify({
        type: 'response',
        id: prompt.id,
        command: 'prompt',
        success: true,
        data: { disposition: 'handled' },
      }) + '\n',
    )
    await expect(result).resolves.toMatchObject({ status: 'completed', output: '' })
    const next = run.prompt('again')
    const nextPrompt = fakeProcess.commands.at(-1)!
    fakeProcess.stdout.write(
      JSON.stringify({ type: 'response', id: nextPrompt.id, command: 'prompt', success: true }) +
        '\n',
    )
    let completed = false
    void next.then(() => {
      completed = true
    })
    await Promise.resolve()
    expect(completed).toBe(false)
    fakeProcess.stdout.write('{"type":"agent_end"}\n')
    await Promise.resolve()
    expect(completed).toBe(false)
    fakeProcess.stdout.write('{"type":"agent_settled","aborted":false}\n')
    await expect(next).resolves.toMatchObject({ status: 'completed' })
  })

  it('correlates responses by command id and appends system text', async () => {
    const fakeProcess = fake()
    let args: string[] = []
    const run = createRun({
      bin: 'pi',
      cwd: '/v',
      model: 'anthropic/claude-sonnet',
      system: 'Follow these rules',
      spawn: (_bin, argv) => {
        args = argv
        return fakeProcess.child
      },
    })
    const result = run.prompt('go')
    expect(args).toEqual(['--mode', 'rpc', '--append-system-prompt', 'Follow these rules'])
    expect(fakeProcess.commands).toMatchObject([
      { type: 'set_model', provider: 'anthropic', modelId: 'claude-sonnet' },
    ])
    fakeProcess.stdout.write(
      '{"type":"response","id":"not-holi-command","success":false,"error":"stale"}\n',
    )
    expect(fakeProcess.commands).toHaveLength(1)
    fakeProcess.stdout.write(
      `{"type":"response","id":"${fakeProcess.commands[0]!.id}","command":"set_model","success":true}\n`,
    )
    expect(fakeProcess.commands.at(-1)).toMatchObject({ type: 'prompt', message: 'go' })
    fakeProcess.stdout.write('{"type":"agent_settled","aborted":false}\n')
    await expect(result).resolves.toMatchObject({ status: 'completed' })
  })

  it('disables every Pi tool and resource source for no-tools runs', () => {
    const process = fake()
    const run = createRun({
      bin: 'pi',
      cwd: '/v',
      noTools: true,
      spawn: (_bin, args) => {
        expect(args).toEqual([
          '--mode',
          'rpc',
          '--no-tools',
          '--no-extensions',
          '--no-skills',
          '--no-prompt-templates',
          '--no-context-files',
          '--no-mcp',
          '--no-approve',
        ])
        return process.child
      },
    })
    run.close()
  })

  it('fails and kills the process when Pi rejects a command or aborts a turn', async () => {
    const failedProcess = fake()
    const failedRun = createRun({ bin: 'pi', cwd: '/v', spawn: () => failedProcess.child })
    const failed = failedRun.prompt('go')
    failedProcess.stdout.write(
      `{"type":"response","id":"${failedProcess.commands[0]!.id}","command":"prompt","success":false,"error":"bad prompt"}\n`,
    )
    await expect(failed).resolves.toMatchObject({ status: 'failed', error: 'bad prompt' })

    const abortedProcess = fake()
    const abortedRun = createRun({ bin: 'pi', cwd: '/v', spawn: () => abortedProcess.child })
    const aborted = abortedRun.prompt('go')
    abortedProcess.stdout.write('{"type":"agent_settled","aborted":true}\n')
    await expect(aborted).resolves.toMatchObject({ status: 'aborted' })
  })

  it('does not call a failed model response a completed run', async () => {
    const process = fake()
    const run = createRun({ bin: 'pi', cwd: '/v', spawn: () => process.child })
    const result = run.prompt('go')
    process.stdout.write(
      '{"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"provider unavailable"}}\n',
    )
    process.stdout.write('{"type":"agent_settled","aborted":false}\n')
    await expect(result).resolves.toMatchObject({ status: 'failed', error: 'provider unavailable' })
  })

  it('reports context only from Pi session stats', async () => {
    const process = fake()
    const onStats = vi.fn()
    const run = createRun({ bin: 'pi', cwd: '/v', spawn: () => process.child, onStats })
    const result = run.prompt('go')
    process.stdout.write('{"type":"agent_settled","aborted":false}\n')
    let completed = false
    void result.then(() => {
      completed = true
    })
    await Promise.resolve()
    expect(completed).toBe(false)
    const request = process.commands.at(-1)
    expect(request?.type).toBe('get_session_stats')
    process.stdout.write(
      JSON.stringify({
        id: request?.id,
        type: 'response',
        command: 'get_session_stats',
        success: true,
        data: {
          tokens: { input: 12, output: 8, total: 20 },
          cost: 0.04,
          contextUsage: { percent: 13 },
        },
      }) + '\n',
    )
    await expect(result).resolves.toMatchObject({ status: 'completed' })
    expect(onStats).toHaveBeenCalledWith({
      usage: { input: 12, output: 8, total: 20, cost: 0.04 },
      contextPercent: 13,
    })
    run.close()
  })

  it('keeps close and cancel pending until the child close event', async () => {
    const process = fake(false)
    const run = createRun({ bin: 'pi', cwd: '/v', spawn: () => process.child })
    const result = run.prompt('x')
    let closeDone = false
    const closing = run.close().then(() => {
      closeDone = true
    })
    const repeated = run.close()
    await expect(result).resolves.toMatchObject({ status: 'aborted' })
    await Promise.resolve()
    expect(closeDone).toBe(false)
    process.close()
    await Promise.all([closing, repeated])
    expect(closeDone).toBe(true)
  })

  it('keeps cancel pending until the child close event', async () => {
    const process = fake(false)
    const run = createRun({ bin: 'pi', cwd: '/v', spawn: () => process.child })
    const result = run.prompt('x')
    let cancelled = false
    const cancelling = run.cancel().then(() => {
      cancelled = true
    })
    await expect(result).resolves.toMatchObject({ status: 'aborted' })
    await Promise.resolve()
    expect(cancelled).toBe(false)
    process.close()
    await Promise.all([cancelling, run.cancel()])
    expect(cancelled).toBe(true)
  })

  it('fails queued input on stdin errors and drains after launch errors', async () => {
    const input = fake()
    const run = createRun({ bin: 'pi', cwd: '/v', spawn: () => input.child })
    const result = run.prompt('queued')
    input.child.stdin.destroy(new Error('EPIPE'))
    await expect(result).resolves.toMatchObject({ status: 'failed', error: 'EPIPE' })
    await run.drained

    const launch = fake(false)
    const failed = createRun({ bin: 'pi', cwd: '/v', spawn: () => launch.child })
    launch.error(new Error('spawn failed'))
    let drained = false
    const draining = failed.close().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    launch.close()
    await draining
  })

  it('cancels and kills the managed child', async () => {
    const fakeProcess = fake()
    const run = createRun({ bin: 'pi', cwd: '/v', spawn: () => fakeProcess.child })
    const result = run.prompt('x')
    run.cancel()
    await expect(result).resolves.toMatchObject({ status: 'aborted' })
    expect(fakeProcess.commands.map((c) => c.type)).toEqual(['prompt', 'abort'])
  })
})
