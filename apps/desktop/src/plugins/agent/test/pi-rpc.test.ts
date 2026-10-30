import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { PiRpcRun, type PiChild } from '../main/pi/rpc'

function fake() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const commands: Record<string, unknown>[] = []
  stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().trim().split('\n'))
      if (line) commands.push(JSON.parse(line) as Record<string, unknown>)
  })
  let exit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
  const child: PiChild = {
    stdin,
    stdout,
    stderr,
    once(event, listener) {
      if (event === 'exit')
        exit = listener as (code: number | null, signal: NodeJS.Signals | null) => void
      else if (event === 'error') stdin.once('error', listener as (error: Error) => void)
      return this
    },
    kill() {
      exit?.(null, 'SIGTERM')
      return true
    },
  }
  return { child, stdout, commands }
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

  it('waits for settlement after a command acknowledgement and reuses the RPC process', async () => {
    const fakeProcess = fake()
    const run = new PiRpcRun({ bin: 'pi', cwd: '/v', spawn: () => fakeProcess.child })
    const result = run.prompt('/handled')
    fakeProcess.stdout.write(
      '{"type":"response","command":"prompt","success":true,"data":{"disposition":"handled"}}\n',
    )
    let resolved = false
    void result.then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false)
    fakeProcess.stdout.write('{"type":"agent_settled","aborted":false}\n')
    await expect(result).resolves.toMatchObject({ status: 'completed' })
    const next = run.prompt('again')
    fakeProcess.stdout.write('{"type":"agent_settled","aborted":false}\n')
    await expect(next).resolves.toMatchObject({ status: 'completed' })
  })

  it('sets models with provider and modelId, waits for the acknowledgement, and appends system text', async () => {
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
      `{"type":"response","id":"${fakeProcess.commands[0]!.id}","command":"set_model","success":true}\n`,
    )
    expect(fakeProcess.commands.at(-1)).toMatchObject({ type: 'prompt', message: 'go' })
    fakeProcess.stdout.write('{"type":"agent_settled","aborted":false}\n')
    await expect(result).resolves.toMatchObject({ status: 'completed' })
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

  it('cancels and kills the managed child', async () => {
    const fakeProcess = fake()
    const run = new PiRpcRun({ bin: 'pi', cwd: '/v', spawn: () => fakeProcess.child })
    const result = run.prompt('x')
    run.cancel()
    await expect(result).resolves.toMatchObject({ status: 'aborted' })
    expect(fakeProcess.commands.map((c) => c.type)).toEqual(['prompt', 'abort'])
  })
})
