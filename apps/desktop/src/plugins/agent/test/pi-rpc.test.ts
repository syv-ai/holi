import { PassThrough } from 'node:stream'
import { setImmediate as tick } from 'node:timers/promises'
import { posixFixtureLedger } from '../../../../test/fixtures/posix-fixture-ledger'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PiRpcRun, type PiChild } from '../main/pi/rpc'
import { ownedProcessDrain, spawnOwnedProgram } from '../../../main/plugin-api'

vi.mock('../../../main/plugin-api', { spy: true })

function fake(autoClose = true) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const commands: Record<string, unknown>[] = []
  stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().trim().split('\n'))
      if (line) commands.push(JSON.parse(line) as Record<string, unknown>)
  })
  let exit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
  let close: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
  let childError: ((error: Error) => void) | undefined
  let exited = false
  const rootExit = (code: number | null, signal: NodeJS.Signals | null) => {
    exited = true
    exit?.(code, signal)
  }
  function closeWithOutput(code: number | null, signal: NodeJS.Signals | null) {
    if (stdout.readableEnded || stdout.destroyed) close?.(code, signal)
    else {
      stdout.once('end', () => close?.(code, signal))
      stdout.end()
    }
  }
  const child: PiChild = {
    [ownedProcessDrain]: {
      drain: async () => {
        if (!exited) child.kill()
      },
    },
    stdin,
    stdout,
    stderr,
    once(event, listener) {
      if (event === 'exit')
        exit = listener as (code: number | null, signal: NodeJS.Signals | null) => void
      else if (event === 'close')
        close = listener as (code: number | null, signal: NodeJS.Signals | null) => void
      else if (event === 'error') childError = listener as (error: Error) => void
      return this
    },
    kill() {
      rootExit(null, 'SIGTERM')
      if (autoClose) closeWithOutput(null, 'SIGTERM')
      return true
    },
  }
  return {
    child,
    stdout,
    commands,
    exit: () => {
      rootExit(1, null)
      closeWithOutput(1, null)
    },
    rootExit: () => rootExit(1, null),
    error: (error: Error) => childError?.(error),
    close: () => closeWithOutput(null, null),
    childCloseOnly: () => close?.(null, null),
  }
}

afterEach(() => vi.useRealTimers())

describe('PiRpcRun', () => {
  it.each(['missing close', 'missing end', 'output before proof'] as const)(
    'starts the output deadline only after physical proof: %s',
    async (mode) => {
      vi.useFakeTimers()
      const rpc = fake(false)
      const drain = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 9000)))
      const child = Object.assign(rpc.child, { [ownedProcessDrain]: { drain } })
      const run = new PiRpcRun({ bin: 'pi', cwd: '/v', spawn: () => child })
      const drained = vi.fn()
      const turn = vi.fn()
      void run.drained.then(() => drained('ok'), drained)
      if (mode === 'missing end') void run.prompt('go').then(() => turn('ok'), turn)
      rpc.rootExit()
      if (mode === 'missing end') rpc.stdout.write('{"type":"agent_settled"}')
      if (mode !== 'missing end') {
        rpc.stdout.end()
        await tick()
      }
      if (mode === 'missing end') rpc.childCloseOnly()
      if (mode === 'output before proof') rpc.close()
      await vi.advanceTimersByTimeAsync(8999)
      expect(drained).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      if (mode === 'output before proof') {
        expect(drained).toHaveBeenCalledExactlyOnceWith('ok')
      } else {
        await vi.advanceTimersByTimeAsync(4999)
        expect(drained).not.toHaveBeenCalled()
        expect(turn).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(drained).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ message: expect.stringMatching(/Pi RPC output.*timed out/i) }),
        )
        const failure: unknown = drained.mock.calls[0]?.[0]
        if (mode === 'missing end') expect(turn).toHaveBeenCalledExactlyOnceWith(failure)
        rpc.stdout.end()
        await tick()
        rpc.close()
        await expect(run.close()).rejects.toBe(failure)
        await expect(run.cancel()).rejects.toBe(failure)
      }
      expect(drain).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it.each(['destroy', 'error'] as const)('rejects truncated stdout after %s', async (mode) => {
    const rpc = fake(false)
    const onStats = vi.fn()
    const run = new PiRpcRun({ bin: 'pi', cwd: '/v', spawn: () => rpc.child, onStats })
    const turn = vi.fn()
    void run.prompt('go').then(() => turn('success'), turn)
    rpc.stdout.write('{"type":"agent_settled"}\n')
    const request = rpc.commands.at(-1)
    expect(request?.type).toBe('get_session_stats')
    rpc.rootExit()
    rpc.stdout.write(JSON.stringify({ type: 'response', id: request?.id, success: true, data: {} }))
    const cause = mode === 'error' ? new Error('broken stdout') : undefined
    rpc.stdout.destroy(cause)
    await tick()
    expect(turn).toHaveBeenCalledExactlyOnceWith(
      cause ?? expect.objectContaining({ message: expect.stringMatching(/stdout.*before.*end/i) }),
    )
    expect(onStats).not.toHaveBeenCalled()
    const failure: unknown = turn.mock.calls[0]?.[0]
    rpc.stdout.emit('error', new Error('later stdout error'))
    rpc.close()
    await expect(run.drained).rejects.toBe(failure)
    await expect(run.close()).rejects.toBe(failure)
  })
  it('uses one RPC process, frames commands and waits for agent_settled', async () => {
    const fakeProcess = fake()
    const run = new PiRpcRun({
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
    const run = new PiRpcRun({
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
    const run = new PiRpcRun({ bin: 'pi', cwd: '/v', spawn: () => process.child })
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
    const run = new PiRpcRun({ bin: 'pi', cwd: '/v', spawn: () => process.child })
    const first = run.prompt('first')
    process.stdout.write('{"type":"agent_settled","aborted":false}\n')
    await expect(first).resolves.toMatchObject({ status: 'completed' })
    process.exit()
    expect(() => run.followUp('second')).toThrow(/process exited/)
  })

  it('bounds output and rejects an oversized partial record', async () => {
    const fakeProcess = fake()
    const run = new PiRpcRun({
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
    fakeProcess.stdout.write('{"type":"agent_settled"}\n')
    await expect(result).resolves.toMatchObject({ status: 'completed', output: 'lon' })
    const next = run.prompt('next')
    fakeProcess.stdout.write('1'.repeat(129))
    await expect(next).rejects.toThrow('oversized record')
    await expect(run.drained).rejects.toThrow('oversized record')
  })

  it('fails after repeated malformed records without treating one bad line as settlement', async () => {
    const process = fake()
    const run = new PiRpcRun({ bin: 'pi', cwd: '/v', spawn: () => process.child })
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
      const run = new PiRpcRun({ bin: 'pi', cwd: '/v', spawn: () => process.child })
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
    const run = new PiRpcRun({ bin: 'pi', cwd: '/v', spawn: () => process.child })
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
    const run = new PiRpcRun({ bin: 'pi', cwd: '/v', spawn: () => fakeProcess.child })
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
    const run = new PiRpcRun({
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
    const run = new PiRpcRun({
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
    const failedRun = new PiRpcRun({ bin: 'pi', cwd: '/v', spawn: () => failedProcess.child })
    const failed = failedRun.prompt('go')
    failedProcess.stdout.write(
      `{"type":"response","id":"${failedProcess.commands[0]!.id}","command":"prompt","success":false,"error":"bad prompt"}\n`,
    )
    await expect(failed).resolves.toMatchObject({ status: 'failed', error: 'bad prompt' })

    const abortedProcess = fake()
    const abortedRun = new PiRpcRun({ bin: 'pi', cwd: '/v', spawn: () => abortedProcess.child })
    const aborted = abortedRun.prompt('go')
    abortedProcess.stdout.write('{"type":"agent_settled","aborted":true}\n')
    await expect(aborted).resolves.toMatchObject({ status: 'aborted' })
  })

  it('does not call a failed model response a completed run', async () => {
    const process = fake()
    const run = new PiRpcRun({ bin: 'pi', cwd: '/v', spawn: () => process.child })
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
    const run = new PiRpcRun({ bin: 'pi', cwd: '/v', spawn: () => process.child, onStats })
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
    expect(run.isAlive).toBe(true)
    await run.close()
  })

  it.each(['proof succeeds', 'proof rejects'] as const)(
    'retains the malformed EOF cause and joins physical drain when %s',
    async (mode) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const rpc = fake(false)
      let finishProof!: () => void
      let failProof!: (error: Error) => void
      const proof = new Promise<void>((resolve, reject) => {
        finishProof = resolve
        failProof = reject
      })
      const drain = vi.fn(() => proof)
      const onDrainFailure = vi.fn()
      const run = new PiRpcRun({
        bin: 'pi',
        cwd: '/v',
        spawn: () => Object.assign(rpc.child, { [ownedProcessDrain]: { drain } }),
        onDrainFailure,
      })
      const turn = vi.fn()
      const drained = vi.fn()
      void run.prompt('go').then(turn, turn)
      void run.drained.then(drained, drained)
      rpc.rootExit()
      rpc.stdout.write('{"type":"agent_settled"}\n')
      rpc.stdout.end('{"type":"message_update"')
      await tick()
      rpc.close()
      expect(drained).not.toHaveBeenCalled()
      if (mode === 'proof rejects') failProof(new Error('later physical failure'))
      else finishProof()
      await tick()
      expect(turn).toHaveBeenCalledExactlyOnceWith(expect.any(SyntaxError))
      const cause: unknown = turn.mock.calls[0]?.[0]
      expect(onDrainFailure).toHaveBeenCalledExactlyOnceWith(cause)
      expect(drained).toHaveBeenCalledExactlyOnceWith(cause)
      await expect(run.close()).rejects.toBe(cause)
      await expect(run.cancel()).rejects.toBe(cause)
      expect(drain).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it.each([
    { exitFirst: true, oversized: false },
    { exitFirst: false, oversized: false },
    { exitFirst: true, oversized: true },
    { exitFirst: false, oversized: true },
  ])(
    'rejects an active invalid tail (exit first: $exitFirst, oversized: $oversized)',
    async ({ exitFirst, oversized }) => {
      const rpc = fake(false)
      const drain = vi.fn(async () => {})
      const run = new PiRpcRun({
        bin: 'pi',
        cwd: '/v',
        maxLineBytes: 64,
        onStats: vi.fn(),
        spawn: () => Object.assign(rpc.child, { [ownedProcessDrain]: { drain } }),
      })
      const result = run.prompt('go').catch((error: unknown) => error)
      if (exitFirst) rpc.rootExit()
      rpc.stdout.end(
        `{"type":"agent_settled"}\n${oversized ? '"' + 'x'.repeat(64) + '"' : '{"type":'}`,
      )
      await tick()
      if (!exitFirst) rpc.rootExit()
      rpc.close()
      const cause = await result
      expect(cause).toEqual(expect.any(oversized ? Error : SyntaxError))
      await expect(run.drained).rejects.toBe(cause)
      expect(drain).toHaveBeenCalledOnce()
    },
  )

  it('accepts whitespace after the last complete record of an exiting turn', async () => {
    const rpc = fake(false)
    const run = new PiRpcRun({ bin: 'pi', cwd: '/v', spawn: () => rpc.child })
    const result = run.prompt('go')
    rpc.rootExit()
    rpc.stdout.end('{"type":"agent_settled"}\n \t\r')
    rpc.close()
    await expect(result).resolves.toMatchObject({ status: 'completed' })
    await run.drained
  })

  it.each(['json', 'whitespace'] as const)(
    'accepts stdout-first EOF with a %s tail',
    async (tail) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const rpc = fake(false)
      const run = new PiRpcRun({
        bin: 'pi',
        cwd: '/v',
        spawn: () => rpc.child,
        onStats: vi.fn(),
        maxLineBytes: 64,
      })
      const result = run.prompt('go')
      const done = vi.fn()
      void result.then(done, done)
      if (tail === 'json') rpc.stdout.end('{"type":"agent_settled"}')
      else {
        rpc.stdout.write('{"type":"agent_settled"}\n')
        rpc.stdout.write(' '.repeat(130))
        rpc.stdout.end('\t')
      }
      await tick()
      await vi.advanceTimersByTimeAsync(1000)
      expect(done).not.toHaveBeenCalled()
      rpc.rootExit()
      rpc.close()
      await expect(result).resolves.toMatchObject({ status: 'completed' })
      await expect(run.drained).resolves.toBeUndefined()
    },
  )

  it.skipIf(process.platform === 'win32')(
    'bounds stdout-first EOF while the root stays live',
    async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const rpc = fake(false)
      let rejectPhysical!: (cause: Error) => void
      const drain = vi.fn(
        () =>
          new Promise<void>((_, reject) => {
            rejectPhysical = reject
          }),
      )
      const failure = vi.fn()
      const run = new PiRpcRun({
        bin: 'pi',
        cwd: '/v',
        onStats: vi.fn(),
        onDrainFailure: failure,
        spawn: () => Object.assign(rpc.child, { [ownedProcessDrain]: { drain } }),
      })
      const done = vi.fn()
      void run.prompt('go').then(done, done)
      rpc.stdout.end('{"type":"agent_settled"}\n')
      await tick()
      expect(rpc.commands.map(({ type }) => type)).toEqual(['prompt', 'get_session_stats'])
      await vi.advanceTimersByTimeAsync(4999)
      expect(drain).not.toHaveBeenCalled()
      expect(done).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      const cause: unknown = failure.mock.calls[0]?.[0]
      expect(cause).toMatchObject({
        message: expect.stringMatching(/timed out waiting for root exit/),
      })
      expect(done).toHaveBeenCalledExactlyOnceWith(cause)
      expect(drain).toHaveBeenCalledOnce()
      await expect(run.prompt('late')).rejects.toThrow('not available')
      const settle = vi.fn()
      void run.drained.then(settle, settle)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(settle).not.toHaveBeenCalled() // Native still owns its physical deadline.
      const physicalFailure = new Error('no physical proof')
      rejectPhysical(physicalFailure)
      await expect(run.physicalDrain).rejects.toBe(physicalFailure)
      await expect(run.close()).rejects.toBe(cause)
      expect(drain).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('does not retroactively fail a completed live turn for an idle malformed tail', async () => {
    const rpc = fake(false)
    const run = new PiRpcRun({ bin: 'pi', cwd: '/v', spawn: () => rpc.child })
    const result = run.prompt('go')
    rpc.stdout.write('{"type":"agent_settled"}\n')
    await expect(result).resolves.toMatchObject({ status: 'completed' })
    expect(run.isAlive).toBe(true)
    rpc.stdout.end('{"type":')
    await tick()
    rpc.rootExit()
    rpc.close()
    await expect(run.drained).resolves.toBeUndefined()
  })

  it('starts physical drain on root exit but reads buffered final RPC records', async () => {
    const rpc = fake(false)
    const drain = vi.fn(async () => {})
    const child = Object.assign(rpc.child, { [ownedProcessDrain]: { drain } })
    const run = new PiRpcRun({ bin: 'pi', cwd: '/v', spawn: () => child, onStats: vi.fn() })
    const result = run.prompt('go')
    const drained = vi.fn()
    void run.drained.then(drained)

    rpc.rootExit()
    expect(drain).toHaveBeenCalledOnce()
    rpc.error(new Error('late error after drain started'))
    const completed = vi.fn()
    void result.then(completed)
    rpc.stdout.write(
      '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"final "}}\n{"type":"agent_settled","aborted":false}\n',
    )
    await tick()
    expect(completed).not.toHaveBeenCalled()
    rpc.stdout.end(
      '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"answer"}}',
    )
    await expect(result).resolves.toMatchObject({ status: 'completed', output: 'final answer' })
    expect(rpc.commands.map((command) => command.type)).toEqual(['prompt'])
    expect(drained).not.toHaveBeenCalled()
    rpc.close()
    await run.close()
    expect(drained).toHaveBeenCalledOnce()
  })

  it('waits for stdout EOF before classifying an incomplete exiting turn', async () => {
    const rpc = fake(false)
    const drain = vi.fn(async () => {})
    const child = Object.assign(rpc.child, { [ownedProcessDrain]: { drain } })
    const run = new PiRpcRun({ bin: 'pi', cwd: '/v', spawn: () => child })
    const result = run.prompt('go')
    rpc.rootExit()
    rpc.stdout.end(
      '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"partial"}}',
    )
    await expect(result).resolves.toMatchObject({
      status: 'failed',
      output: 'partial',
      error: 'Pi RPC exited (1)',
    })
    rpc.close()
    await run.drained
  })

  it.each(['throw', 'reject'] as const)('memoizes a drain %s even without close', async (mode) => {
    const rpc = fake(false)
    const failure = new Error('lost lease')
    const drain = vi.fn(() => {
      if (mode === 'throw') throw failure
      return Promise.reject(failure)
    })
    const child = Object.assign(rpc.child, { [ownedProcessDrain]: { drain } })
    const run = new PiRpcRun({ bin: 'pi', cwd: '/v', spawn: () => child })
    const turn = run.prompt('go')
    const failedTurn = expect(turn).rejects.toBe(failure)
    rpc.rootExit()
    rpc.error(new Error('later child error'))
    await failedTurn
    await expect(run.drained).rejects.toBe(failure)
    await expect(run.close()).rejects.toBe(failure)
    await expect(run.cancel()).rejects.toBe(failure)
    expect(drain).toHaveBeenCalledOnce()
  })

  it.each([true, false])('orders pending stats and EOF (newline: %s)', async (newline) => {
    const rpc = fake(false)
    const onStats = vi.fn()
    const run = new PiRpcRun({ bin: 'pi', cwd: '/v', spawn: () => rpc.child, onStats })
    const result = run.prompt('go')
    const completed = vi.fn()
    void result.then(completed)
    rpc.stdout.write(
      '{"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"native model failed"}}\n{"type":"agent_settled"}\n',
    )
    const request = rpc.commands.at(-1)
    expect(request?.type).toBe('get_session_stats')
    rpc.rootExit()
    rpc.stdout.write(
      JSON.stringify({
        type: 'response',
        id: request?.id,
        success: true,
        data: { tokens: { total: 12 } },
      }) + (newline ? '\n' : ''),
    )
    await tick()
    expect(onStats).not.toHaveBeenCalled()
    expect(completed).not.toHaveBeenCalled()
    rpc.stdout.end()
    await expect(result).resolves.toMatchObject({ status: 'failed', error: 'native model failed' })
    expect(onStats).toHaveBeenCalledExactlyOnceWith({ usage: { total: 12 } })
    rpc.close()
    await run.drained
  })

  it.skipIf(process.platform === 'win32')(
    'completes ordinary native turns without waiting for EOF',
    async () => {
      const ledger = await posixFixtureLedger('holi-pi-live-turn-')
      let run: PiRpcRun | undefined
      try {
        const child = spawnOwnedProgram(
          process.execPath,
          [
            '-e',
            `
        const send = (record) => console.log(JSON.stringify(record));
        require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
          const { type, id, message } = JSON.parse(line);
          if (type === 'prompt') {
            send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: message } });
            send({ type: 'agent_settled' });
          } else if (type === 'get_session_stats') {
            send({ type: 'response', id, success: true, data: { tokens: { total: 4 } } });
          }
        });
      `,
          ],
          { cwd: ledger.root, env: {}, stdio: 'pipe', posixGroupLease: true },
        ) as PiChild & ReturnType<typeof spawnOwnedProgram>
        const pid = ledger.record(child)
        const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
        const identify = ledger.retain(
          pid,
          child[ownedProcessDrain]!.drain,
          closed,
          'Pi RPC control',
        )
        const admitted = new Promise<void>((resolve, reject) => {
          child.once('error', reject)
          child.once('spawn', () => {
            try {
              identify()
              resolve()
            } catch (error) {
              reject(error)
            }
          })
        })
        const onStats = vi.fn()
        run = new PiRpcRun({ bin: 'pi', cwd: ledger.root, spawn: () => child, onStats })
        await admitted
        for (const text of ['first', 'second']) {
          const result = vi.fn()
          void run.prompt(text).then(result, result)
          await vi.waitFor(() =>
            expect(result).toHaveBeenCalledWith(
              expect.objectContaining({ status: 'completed', output: text }),
            ),
          )
          expect(child.stdout.readableEnded).toBe(false)
          expect(run.isAlive).toBe(true)
        }
        expect(onStats).toHaveBeenCalledTimes(2)
      } finally {
        try {
          await run?.close()
        } finally {
          await ledger.reap()
          await ledger.remove()
        }
      }
    },
  )

  it('does not accept close as process proof from an adapter without a receipt', async () => {
    const rpc = fake(false)
    const child = {
      ...rpc.child,
      [ownedProcessDrain]: undefined,
      pid: 4242,
      kill: vi.fn(() => true),
    }
    const run = new PiRpcRun({ bin: 'pi', cwd: '/v', spawn: () => child })
    // Missing proof has already rejected, even before any lifecycle event.
    const state = vi.fn()
    void run.drained.then(state, state)
    await Promise.resolve()
    expect(state).toHaveBeenCalledWith(expect.any(Error))
    rpc.rootExit()
    rpc.close()
    await expect(run.close()).rejects.toThrow(/ownership proof/)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it.each([
    'ignores TERM',
    'throws on TERM',
    'exits before retry',
    'already closed',
    'output error',
  ] as const)('uses the Windows helper stop baseline: %s', async (mode) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const rpc = fake(false)
    const cause = new Error('original output error')
    const onDrainFailure = vi.fn()
    delete rpc.child[ownedProcessDrain]
    const kill = vi.spyOn(rpc.child, 'kill').mockImplementation((signal) => {
      if (signal === 'SIGTERM' && mode !== 'ignores TERM' && mode !== 'exits before retry')
        throw new Error('stop-file write failed')
      if (signal === 'SIGKILL') rpc.exit()
      return true
    })
    const spawn = vi.mocked(spawnOwnedProgram)
    spawn.mockReturnValueOnce(rpc.child as unknown as ReturnType<typeof spawnOwnedProgram>)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    try {
      const run = new PiRpcRun({ bin: 'never-spawned', cwd: '/v', onDrainFailure })
      if (mode === 'already closed') {
        rpc.exit()
        await run.close()
        await vi.advanceTimersByTimeAsync(5_000)
        expect(kill).not.toHaveBeenCalled()
        return
      }
      const turn = run.prompt('go')
      if (mode === 'output error') rpc.stdout.destroy(cause)
      const stopping = mode === 'output error' ? run.drained : run.cancel()
      const settled = vi.fn()
      void stopping.then(settled, settled)
      if (mode === 'output error') await expect(turn).rejects.toBe(cause)
      else await expect(turn).resolves.toMatchObject({ status: 'aborted' })
      expect(kill.mock.calls).toEqual([['SIGTERM']])
      await vi.advanceTimersByTimeAsync(1_499)
      if (mode !== 'output error') expect(settled).not.toHaveBeenCalled()
      expect(kill.mock.calls).toEqual([['SIGTERM']])
      if (mode === 'exits before retry') rpc.exit()
      await vi.advanceTimersByTimeAsync(1)
      expect(kill.mock.calls).toEqual(
        mode === 'exits before retry' ? [['SIGTERM']] : [['SIGTERM'], ['SIGKILL']],
      )
      if (mode === 'output error') {
        await expect(stopping).rejects.toBe(cause)
        expect(onDrainFailure).toHaveBeenCalledExactlyOnceWith(cause)
      } else {
        await stopping
        expect(onDrainFailure).not.toHaveBeenCalled()
      }
      await vi.advanceTimersByTimeAsync(5_000)
      expect(kill).toHaveBeenCalledTimes(mode === 'exits before retry' ? 1 : 2)
    } finally {
      Object.defineProperty(process, 'platform', platform)
      kill.mockRestore()
      vi.clearAllTimers()
    }
  })

  it('keeps close and cancel pending until the child close event', async () => {
    const process = fake(false)
    const run = new PiRpcRun({ bin: 'pi', cwd: '/v', spawn: () => process.child })
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
    const run = new PiRpcRun({ bin: 'pi', cwd: '/v', spawn: () => process.child })
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
    const run = new PiRpcRun({ bin: 'pi', cwd: '/v', spawn: () => input.child })
    const result = run.prompt('queued')
    input.child.stdin.destroy(new Error('EPIPE'))
    await expect(result).resolves.toMatchObject({ status: 'failed', error: 'EPIPE' })
    await run.drained

    const launch = fake(false)
    const failed = new PiRpcRun({ bin: 'pi', cwd: '/v', spawn: () => launch.child })
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
    const run = new PiRpcRun({ bin: 'pi', cwd: '/v', spawn: () => fakeProcess.child })
    const result = run.prompt('x')
    run.cancel()
    await expect(result).resolves.toMatchObject({ status: 'aborted' })
    expect(fakeProcess.commands.map((c) => c.type)).toEqual(['prompt', 'abort'])
  })
})
