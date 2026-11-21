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

describe('pi-rpc Windows integration', () => {
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
})
