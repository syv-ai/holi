import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { PiRpcRun, type PiChild } from '../main/pi/rpc'

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
  const child: PiChild = {
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
      exit?.(null, 'SIGTERM')
      if (autoClose) close?.(null, 'SIGTERM')
      return true
    },
  }
  return {
    child,
    stdout,
    commands,
    exit: () => {
      exit?.(1, null)
      close?.(1, null)
    },
    error: (error: Error) => childError?.(error),
    close: () => close?.(null, null),
  }
}

describe('PiRpcRun', () => {
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

  it('bounds output and returns failed on malformed input limit', async () => {
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
    fakeProcess.stdout.write('1'.repeat(129))
    await expect(result).resolves.toMatchObject({ status: 'failed', output: 'lon' })
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
    run.close()
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
