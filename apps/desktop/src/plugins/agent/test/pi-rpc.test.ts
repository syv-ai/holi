import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
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

  it('cancels and kills the managed child', async () => {
    const fakeProcess = fake()
    const run = new PiRpcRun({ bin: 'pi', cwd: '/v', spawn: () => fakeProcess.child })
    const result = run.prompt('x')
    run.cancel()
    await expect(result).resolves.toMatchObject({ status: 'aborted' })
    expect(fakeProcess.commands.map((c) => c.type)).toEqual(['prompt', 'abort'])
  })
})
