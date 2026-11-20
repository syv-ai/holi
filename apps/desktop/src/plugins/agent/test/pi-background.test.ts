import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NO_TOOLS } from '../main/pi/rpc'
import { UnconfirmedOwnedProgramError, type OwnedCompletion } from '../../../main/plugin-api'
import { createPiBackground } from '../main/pi/background'
import { agentCapabilities } from '../main/host/capabilities'
import type { CapabilityContext } from '../../../main/capabilities/registry'
import { join } from 'node:path'

function fake(autoClose = true, autoStats = true) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const commands: Record<string, unknown>[] = []
  stdin.on('data', (data: Buffer) => {
    for (const line of data.toString().trim().split('\n')) {
      if (!line) continue
      const command = JSON.parse(line) as { type: string; id: string }
      commands.push(command)
      if (command.type === 'get_session_stats' && autoStats) {
        queueMicrotask(() =>
          stdout.write(
            JSON.stringify({
              id: command.id,
              type: 'response',
              command: 'get_session_stats',
              success: true,
              data: {
                tokens: { input: 12, output: 8, total: 20 },
                cost: 0.04,
                contextUsage: { percent: 13 },
              },
            }) + '\n',
          ),
        )
      }
    }
  })
  const kill = vi.fn(() => {
    child.emit('exit', null, 'SIGTERM')
    if (autoClose) close()
    return true
  })
  const child = Object.assign(new ChildProcess(), { stdin, stdout, stderr, kill })
  function close() {
    stdout.end()
    stderr.end()
    child.emit('close', null, null)
  }
  return {
    child,
    stdout,
    commands,
    exit: () => {
      child.emit('exit', 0, null)
      close()
    },
    close,
    kill,
    wasKilled: () => kill.mock.calls.length > 0,
  }
}

function background(deps: Parameters<typeof createPiBackground>[0]) {
  return createPiBackground({ platform: 'linux', ...deps })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

afterEach(() => vi.useRealTimers())

describe('Pi background runs', () => {
  it('keeps Claude as the default launch provider and dispatches explicit Pi launches', async () => {
    const calls: string[] = []
    const table = agentCapabilities({
      sessions: {
        launch: async () => {
          calls.push('claude')
          return { ok: true, sessionId: 'claude' }
        },
      } as never,
      own: {} as never,
      jobs: { has: () => false, sessions: () => [] } as never,
      fenced: {} as never,
      defaultProvider: async () => 'claude',
      providers: [
        { id: 'claude', installed: () => true },
        { id: 'pi', installed: () => true },
      ] as never,
      terminals: {} as never,
      liveRemote: () => 'owner/vault',
      commitNow: async () => {},
      pi: {
        sessions: () => [],
        launch: async () => {
          calls.push('pi')
          return { ok: true, sessionId: 'pi' }
        },
        message: async () => {},
        reply: () => null,
        stop: async () => ({ ok: true }),
      },
    })
    const ctx = { remote: 'owner/vault' } as CapabilityContext
    const launch = table['agent.launch'] as {
      params(raw: unknown): unknown
      run(ctx: CapabilityContext, args: unknown): Promise<unknown>
    }
    await launch.run(ctx, launch.params({ name: 'default', prompt: 'go' }))
    await launch.run(ctx, launch.params({ name: 'pi', prompt: 'go', provider: 'pi' }))
    await expect(
      launch.run(ctx, launch.params({ name: 'codex', prompt: 'go', provider: 'codex' })),
    ).resolves.toMatchObject({
      ok: false,
      message: 'Codex cannot run unattended jobs in Holi yet.',
    })
    expect(calls).toEqual(['claude', 'pi'])
  })
  it('refuses TUI attach, restart, and duplicate for managed Pi sessions', async () => {
    const pi = {
      sessions: () => [
        { id: 'pi123456', provider: 'pi' as const, name: 'run', state: 'working' as const },
      ],
      launch: async () => ({ ok: true as const, sessionId: 'pi123456' }),
      message: async () => {},
      reply: () => null,
      stop: async () => ({ ok: true as const }),
    }
    const table = agentCapabilities({
      sessions: {
        open: async () => ({ ok: true }),
        respawn: async () => ({ ok: true }),
        duplicate: async () => ({ ok: true }),
      } as never,
      own: { has: () => false } as never,
      jobs: { has: () => false, sessions: () => [] } as never,
      fenced: {} as never,
      defaultProvider: async () => 'claude',
      providers: [] as never,
      terminals: {} as never,
      liveRemote: () => 'owner/vault',
      commitNow: async () => {},
      pi,
    })
    const ctx = { remote: 'owner/vault' } as CapabilityContext
    const open = table['agent.open'] as {
      params(raw: unknown): unknown
      run(ctx: CapabilityContext, args: never): Promise<unknown>
    }
    const respawn = table['agent.respawn'] as {
      params(raw: unknown): unknown
      run(ctx: CapabilityContext, args: never): Promise<unknown>
    }
    const duplicate = table['agent.duplicate'] as {
      params(raw: unknown): unknown
      run(ctx: CapabilityContext, args: never): Promise<unknown>
    }
    await expect(
      open.run(ctx, open.params({ attach: 'pi123456' }) as never),
    ).resolves.toMatchObject({
      ok: false,
      message: 'Pi background sessions have no TUI to attach to.',
    })
    await expect(
      respawn.run(ctx, respawn.params({ id: 'pi123456' }) as never),
    ).resolves.toMatchObject({
      ok: false,
      message: 'Pi background sessions cannot be restarted from a TUI.',
    })
    await expect(
      duplicate.run(ctx, duplicate.params({ id: 'pi123456' }) as never),
    ).resolves.toMatchObject({
      ok: false,
      message: 'Pi background sessions cannot be duplicated from a TUI.',
    })
  })

  it.each(['idle follow-up', 'expiry'] as const)(
    'keeps the original Windows owner and proof failure after %s',
    async (trigger) => {
      vi.useFakeTimers()
      const activation = new AbortController()
      const rpc = fake(false)
      const receipt = deferred<OwnedCompletion>()
      const idle = deferred<void>()
      const manager = background({
        activationSignal: activation.signal,
        bin: () => '/usr/bin/pi',
        platform: 'win32',
        spawn: () => Object.assign(rpc.child, { pid: 43210, ownedCompletion: receipt.promise }),
        bracket: () => {},
        changed: () => {
          if (manager.sessions()[0]?.state === 'idle') idle.resolve()
        },
      })
      manager.setVault('owner/vault', '/vault')
      const started = await manager.launch({ name: 'held', prompt: 'go' })
      if (!started.ok) throw new Error(started.message)
      const id = started.sessionId
      const parsed = rpc.commands.length
      rpc.stdout.write('{"type":"agent_settled","aborted":false}\n')
      expect(rpc.commands[parsed]).toMatchObject({ type: 'get_session_stats' })
      await idle.promise

      if (trigger === 'idle follow-up') rpc.child.emit('exit', 0, null)
      else await vi.advanceTimersByTimeAsync(30_000)
      const messageSettled = vi.fn()
      const stopSettled = vi.fn()
      const message = manager.message(id, 'not admitted').catch((error: unknown) => error)
      const stopping = manager.stop(id).catch((error: unknown) => error)
      void message.then(messageSettled)
      void stopping.then(stopSettled)
      await vi.advanceTimersByTimeAsync(0)
      expect(stopSettled).not.toHaveBeenCalled()
      expect(messageSettled).not.toHaveBeenCalled()
      expect(manager.sessions()).toMatchObject([{ id, state: 'idle' }])
      expect(rpc.commands.filter((command) => command.type === 'prompt')).toHaveLength(1)

      const lease = { revoke: vi.fn(async () => {}) }
      const failure = new UnconfirmedOwnedProgramError(new Error('ownership query failed'), lease)
      receipt.reject(failure)
      // No child close, END, or timeout is needed to deliver this failure.
      expect(await message).toBe(failure)
      expect(await stopping).toBe(failure)
      await expect(manager.stop(id)).rejects.toBe(failure)
      await expect(manager.message(id, 'still not admitted')).rejects.toBe(failure)
      expect(rpc.child.stdout.destroyed).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
      activation.abort()
      const leaving = manager.leave()
      await expect(leaving).rejects.toBe(failure)
      expect(manager.leave()).toBe(leaving)
      await expect(manager.stop(id)).rejects.toBe(failure)
      expect(manager.sessions()).toMatchObject([{ id }])
      expect(failure.lease).toBe(lease)

      const next = background({ bin: () => null, bracket: () => {}, changed: () => {} })
      next.setVault('owner/next', '/next')
      await expect(next.stop(id)).resolves.toMatchObject({ ok: false })
      await expect(next.message(id, 'wrong activation')).rejects.toThrow(/no running Pi session/)
      await next.leave()
      rpc.close()
    },
  )

  it('retires an idle Windows owner on follow-up only after the full join', async () => {
    vi.useFakeTimers()
    const rpc = fake(false)
    const receipt = deferred<OwnedCompletion>()
    const idle = deferred<void>()
    const spawn = vi.fn(() =>
      Object.assign(rpc.child, { pid: 43210, ownedCompletion: receipt.promise }),
    )
    const manager = createPiBackground({
      bin: () => '/usr/bin/pi',
      platform: 'win32',
      spawn,
      bracket: () => {},
      changed: () => {
        if (manager.sessions()[0]?.state === 'idle') idle.resolve()
      },
    })
    manager.setVault('owner/vault', '/vault')
    const started = await manager.launch({ name: 'held output', prompt: 'go', keep: true })
    if (!started.ok) throw new Error(started.message)
    const id = started.sessionId
    rpc.stdout.write('{"type":"agent_settled","aborted":false}\n')
    await idle.promise

    rpc.child.emit('exit', 0, null)
    const settled = vi.fn()
    const message = manager.message(id, 'not admitted').catch((error: unknown) => error)
    void message.then(settled)
    receipt.resolve('empty')
    rpc.stdout.end()
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).not.toHaveBeenCalled()
    expect(manager.sessions()).toMatchObject([{ id, state: 'idle', outcome: 'completed' }])

    rpc.child.stderr.end()
    expect(await message).toEqual(new Error('Pi RPC process exited before the follow-up'))
    expect(manager.sessions()).toEqual([])
    await expect(manager.stop(id)).resolves.toMatchObject({ ok: false })
    await manager.leave()
    expect(rpc.commands.filter((command) => command.type === 'prompt')).toHaveLength(1)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(rpc.kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['clean join', 'proof failure', 'output failure'] as const)(
    'rejects a post-exit follow-up without interrupting the buffered Windows turn: %s',
    async (completion) => {
      vi.useFakeTimers()
      const rpc = fake(false, false)
      const receipt = deferred<OwnedCompletion>()
      const finalized = deferred<void>()
      const bracket = vi.fn(async (_id: string, edge: string) => {
        if (edge === 'end') await finalized.promise
      })
      const changed = vi.fn()
      const spawn = vi.fn(() =>
        Object.assign(rpc.child, { pid: 43210, ownedCompletion: receipt.promise }),
      )
      const manager = createPiBackground({
        bin: () => '/usr/bin/pi',
        platform: 'win32',
        spawn,
        bracket,
        changed,
      })
      manager.setVault('owner/vault', '/vault')
      const started = await manager.launch({ name: 'buffered', prompt: 'go' })
      if (!started.ok) throw new Error(started.message)
      const id = started.sessionId
      rpc.child.emit('exit', 0, null)
      rpc.stdout.write(
        '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"answer"}}\n' +
          '{"type":"agent_settled","aborted":false}\n' +
          `{"type":"response","id":"${rpc.commands[0]!.id}","success":true,"data":{"disposition":"handled"}}\n` +
          '{"type":"agent_settled","aborted":false}\n',
      )
      const expectPending = () => {
        expect(bracket.mock.calls).toEqual([[id, 'begin']])
        expect(manager.sessions()).toMatchObject([
          { id, name: 'buffered', provider: 'pi', state: 'working' },
        ])
        expect(manager.sessions()[0]?.outcome).toBeUndefined()
        expect(manager.reply(id)).toBeNull()
        expect(changed).not.toHaveBeenCalled()
      }
      const rejected = vi.fn()
      const exited = new Error('Pi RPC process exited before the follow-up')
      changed.mockClear()
      void manager.message(id, 'not admitted').catch(rejected)
      await vi.advanceTimersByTimeAsync(1001)
      expect(rejected).toHaveBeenCalledExactlyOnceWith(exited)
      expectPending()

      if (completion === 'proof failure') {
        const lease = { revoke: vi.fn(async () => {}) }
        const commandError = new Error('earlier command error')
        const failure = new UnconfirmedOwnedProgramError(
          new Error('query failed'),
          lease,
          commandError,
        )
        receipt.reject(failure)
        await vi.advanceTimersByTimeAsync(0)
        expect(bracket.mock.calls).toEqual([
          [id, 'begin'],
          [id, 'forget'],
        ])
        expect(manager.reply(id)).toBeNull()
        expect(manager.sessions()).toMatchObject([
          { id, outcome: 'failed', error: commandError.message },
        ])
        expect(rpc.stdout.readableEnded).toBe(false)
        await expect(manager.stop(id)).rejects.toBe(failure)
        await expect(manager.leave()).rejects.toBe(failure)
        expect(manager.sessions()).toMatchObject([{ id, outcome: 'failed' }])
        expect(lease.revoke).not.toHaveBeenCalled()
        rpc.close()
      } else {
        receipt.resolve('empty')
        rpc.stdout.end()
        await vi.advanceTimersByTimeAsync(0)
        expectPending()

        if (completion === 'clean join') {
          rpc.child.stderr.end()
          await vi.advanceTimersByTimeAsync(0)
          expect(bracket.mock.calls).toEqual([
            [id, 'begin'],
            [id, 'end'],
          ])
          expect(manager.sessions()).toMatchObject([{ id, state: 'idle', outcome: 'completed' }])
          expect(manager.reply(id)).toBeNull()
          void manager.message(id, 'not admitted during end').catch(rejected)
          await vi.advanceTimersByTimeAsync(0)
          expect(rejected).toHaveBeenNthCalledWith(2, exited)
          expect(changed).not.toHaveBeenCalled()
          expect(manager.sessions()).toMatchObject([{ id }])

          finalized.resolve()
          await vi.advanceTimersByTimeAsync(0)
          expect(bracket.mock.calls).toEqual([
            [id, 'begin'],
            [id, 'end'],
          ])
          expect(changed).toHaveBeenCalledTimes(1)
          expect(manager.reply(id)).toBe('answer')
          expect(vi.getTimerCount()).toBe(1) // Normal retention starts only after end.
          manager.setVault('owner/next', '/next')
          expect(manager.reply(id)).toBeNull()
          await expect(manager.message(id, 'wrong vault')).rejects.toThrow(/no running Pi session/)
          manager.setVault('owner/vault', '/vault')
          expect(manager.reply(id)).toBe('answer')

          const idle = manager
            .message(id, 'not admitted after end')
            .catch((error: unknown) => error)
          const another = manager.message(id, 'also not admitted').catch((error: unknown) => error)
          expect(await idle).toEqual(exited)
          expect(await another).toBe(await idle)
        } else {
          rpc.child.stderr.destroy()
          await vi.advanceTimersByTimeAsync(0)
          expect(bracket.mock.calls).toEqual([
            [id, 'begin'],
            [id, 'forget'],
          ])
          expect(manager.sessions()).toMatchObject([{ id, outcome: 'failed' }])
          expect(manager.reply(id)).toBeNull()
          await expect(manager.stop(id)).resolves.toEqual({ ok: true })
        }
        expect(manager.sessions()).toEqual([])
        await manager.leave()
      }
      expect(rpc.commands).toEqual([{ id: 'holi-1', type: 'prompt', message: 'go' }])
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(rpc.kill).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('rejects a dead follow-up while a previously live answer finalizes, and Stop still joins', async () => {
    vi.useFakeTimers()
    const rpc = fake(false)
    const receipt = deferred<OwnedCompletion>()
    const finalizing = deferred<void>()
    const finalized = deferred<void>()
    const manager = background({
      bin: () => '/usr/bin/pi',
      platform: 'win32',
      spawn: () => Object.assign(rpc.child, { pid: 43210, ownedCompletion: receipt.promise }),
      bracket: async (_id, edge) => {
        if (edge !== 'end') return
        finalizing.resolve()
        await finalized.promise
      },
      changed: () => {},
    })
    manager.setVault('owner/vault', '/vault')
    const started = await manager.launch({ name: 'held', prompt: 'go' })
    if (!started.ok) throw new Error(started.message)
    const id = started.sessionId
    rpc.stdout.write('{"type":"agent_settled","aborted":false}\n')
    expect(rpc.commands.at(-1)).toMatchObject({ type: 'get_session_stats' })
    await finalizing.promise
    expect(manager.sessions()).toMatchObject([{ id, state: 'idle' }])

    rpc.exit()
    const rejected = vi.fn()
    void manager.message(id, 'not admitted').catch(rejected)
    await vi.advanceTimersByTimeAsync(0)
    expect(rejected).toHaveBeenCalledExactlyOnceWith(
      new Error('Pi RPC process exited before the follow-up'),
    )
    expect(manager.sessions()).toMatchObject([{ id, state: 'idle', outcome: 'completed' }])
    expect(rpc.commands.filter((command) => command.type === 'prompt')).toHaveLength(1)
    const stopped = vi.fn()
    const stopping = manager.stop(id).then(stopped)
    await vi.advanceTimersByTimeAsync(0)
    expect(stopped).not.toHaveBeenCalled()

    receipt.resolve('empty')
    await vi.advanceTimersByTimeAsync(0)
    expect(manager.sessions()).toMatchObject([{ id }])
    expect(stopped).not.toHaveBeenCalled()
    finalized.resolve()
    await stopping
    expect(stopped).toHaveBeenCalledWith({ ok: true })
    expect(manager.sessions()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    await manager.leave()
  })

  it('reports an explicit Windows no-spawn planning error without poisoning leave', async () => {
    const rpc = fake(false)
    const bracket = vi.fn()
    const spawn = vi.fn(() => {
      // This is the no-spawn adapter: no invented PID, no OS signals or probes.
      const child = Object.assign(rpc.child, {
        ownedCompletion: Promise.resolve<OwnedCompletion>('not-started'),
      })
      process.nextTick(() => {
        child.emit('error', new Error('could not plan launch'))
        child.stdin.destroy()
        rpc.close()
      })
      return child
    })
    const manager = background({
      bin: () => '/bad/pi',
      platform: 'win32',
      spawn,
      bracket,
      changed: () => {},
    })
    manager.setVault('owner/vault', '/vault')
    await expect(manager.launch({ name: 'no spawn', prompt: 'go' })).resolves.toEqual({
      ok: false,
      message: 'Could not start Pi: Error: could not plan launch',
    })
    expect(rpc.commands).toHaveLength(0)
    expect(rpc.kill).not.toHaveBeenCalled()
    expect(bracket).not.toHaveBeenCalled()
    expect(manager.sessions()).toEqual([])
    await expect(manager.leave()).resolves.toBeUndefined()
  })

  it('does not use a missing Windows PID as proof that nothing was spawned', async () => {
    const rpc = fake(false)
    const manager = background({
      bin: () => '/usr/bin/pi',
      platform: 'win32',
      spawn: () => rpc.child,
      bracket: () => {},
      changed: () => {},
    })
    manager.setVault('owner/vault', '/vault')
    const failure = await manager
      .launch({ name: 'unknown', prompt: 'go' })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(UnconfirmedOwnedProgramError)
    expect(rpc.commands).toHaveLength(0)
    expect(rpc.kill).not.toHaveBeenCalled()
    await expect(manager.leave()).rejects.toBe(failure)
    rpc.close()
  })

  it('launches one managed RPC job, brackets turns, delivers follow-ups and stops', async () => {
    const rpc = fake()
    const brackets: string[] = []
    const manager = background({
      bin: () => '/usr/bin/pi',
      spawn: (_bin, args, options) => {
        expect(args).toEqual(['--mode', 'rpc', '--append-system-prompt', 'System direction'])
        expect(options.cwd).toBe('/vault')
        return rpc.child
      },
      bracket: (_id, edge) => brackets.push(edge),
      changed: () => {},
    })
    manager.setVault('owner/vault', '/vault')
    const launched = await manager.launch({
      name: 'Review',
      prompt: 'Review this',
      model: 'provider/test-model',
      system: 'System direction',
    })
    expect(launched.ok).toBe(true)
    if (!launched.ok) throw new Error(launched.message)
    const id = launched.sessionId
    expect(manager.sessions()).toMatchObject([
      { id, provider: 'pi', name: 'Review', state: 'working' },
    ])
    expect(rpc.commands.map((command) => command.type)).toEqual(['set_model'])
    expect(rpc.commands[0]).toMatchObject({ provider: 'provider', modelId: 'test-model' })
    rpc.stdout.write(
      `{"type":"response","id":"${rpc.commands[0]!.id}","command":"set_model","success":true}\n`,
    )
    expect(rpc.commands.at(-1)).toMatchObject({ type: 'prompt', message: 'Review this' })
    rpc.stdout.write('{"type":"agent_settled","aborted":false}\n')
    await new Promise((resolve) => setImmediate(resolve))
    expect(manager.sessions()).toMatchObject([
      {
        id,
        state: 'idle',
        usage: { input: 12, output: 8, total: 20, cost: 0.04 },
        contextPercent: 13,
      },
    ])
    rpc.exit()
    await expect(manager.message(id, 'Follow up')).rejects.toThrow(/process exited/)
    await expect(manager.stop(id)).resolves.toMatchObject({ ok: false })
    await manager.leave()
    expect(brackets).toEqual(['begin', 'end'])
    expect(manager.sessions()).toEqual([])
  })

  it('acknowledges a follow-up before its turn finishes and drains held close on leave', async () => {
    const rpc = fake(false)
    const manager = background({
      bin: () => '/usr/bin/pi',
      spawn: () => rpc.child,
      bracket: () => {},
      changed: () => {},
    })
    manager.setVault('owner/vault', '/vault')
    const launched = await manager.launch({ name: 'x', prompt: 'first' })
    if (!launched.ok) throw new Error(launched.message)
    rpc.stdout.write('{"type":"agent_settled","aborted":false}\n')
    await new Promise((resolve) => setImmediate(resolve))

    await expect(manager.message(launched.sessionId, 'second')).resolves.toBeUndefined()
    expect(rpc.commands.filter((command) => command.type === 'prompt')).toHaveLength(2)
    let left = false
    const leaving = manager.leave().then(() => {
      left = true
    })
    await Promise.resolve()
    expect(left).toBe(false)
    rpc.close()
    await leaving
    expect(left).toBe(true)
  })

  it('uses native usage totals and nested cost when session stats are unavailable', async () => {
    const rpc = fake(true, false)
    const manager = background({
      bin: () => '/usr/bin/pi',
      spawn: () => rpc.child,
      bracket: () => {},
      changed: () => {},
    })
    manager.setVault('owner/vault', '/vault')
    const launched = await manager.launch({ name: 'x', prompt: 'first' })
    if (!launched.ok) throw new Error(launched.message)
    rpc.stdout.write(
      '{"type":"message_end","message":{"role":"assistant","usage":{"input":12,"output":8,"totalTokens":20,"cost":{"total":0.04}}}}\n{"type":"agent_settled","aborted":false}\n',
    )
    await new Promise((resolve) => setImmediate(resolve))
    const stats = rpc.commands.find((command) => command.type === 'get_session_stats')
    if (!stats) throw new Error('expected session stats request')
    rpc.stdout.write(
      JSON.stringify({
        type: 'response',
        id: stats.id,
        command: 'get_session_stats',
        success: false,
      }) + '\n',
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect(manager.sessions()[0]?.usage).toEqual({ input: 12, output: 8, total: 20, cost: 0.04 })
    await manager.leave()
  })

  it('keeps a successful Pi process available for follow-ups, then expires it and its row', async () => {
    vi.useFakeTimers()
    const rpc = fake()
    const manager = background({
      bin: () => '/usr/bin/pi',
      spawn: () => rpc.child,
      bracket: () => {},
      changed: () => {},
    })
    manager.setVault('owner/vault', '/vault')
    const started = await manager.launch({ name: 'x', prompt: 'first' })
    if (!started.ok) throw new Error(started.message)
    rpc.stdout.write('{"type":"agent_settled","aborted":false}\n')
    await Promise.resolve()
    await Promise.resolve()
    expect(manager.sessions()[0]?.outcome).toBe('completed')
    expect(manager.sessions()).toHaveLength(1)

    await manager.message(started.sessionId, 'second')
    await Promise.resolve()
    expect(rpc.commands.filter((command) => command.type === 'prompt')).toHaveLength(2)
    rpc.stdout.write('{"type":"agent_settled","aborted":false}\n')
    await Promise.resolve()
    await Promise.resolve()
    expect(manager.sessions()[0]?.outcome).toBe('completed')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(rpc.wasKilled()).toBe(true)
    expect(manager.sessions()).toEqual([])
    await expect(manager.message(started.sessionId, 'too late')).rejects.toThrow(
      /no running Pi session/,
    )
    await manager.leave()
  })

  it('runs a tool-less run kept between turns, whose last answer can be read', async () => {
    vi.useFakeTimers()
    const rpc = fake()
    let argv: string[] = []
    const manager = background({
      bin: () => '/usr/bin/pi',
      spawn: (_bin, args) => {
        argv = args
        return rpc.child
      },
      bracket: () => {},
      changed: () => {},
    })
    manager.setVault('owner/vault', '/vault')
    const started = await manager.launch({
      name: 'scribe',
      prompt: 'first',
      noTools: true,
      keep: true,
    })
    if (!started.ok) throw new Error(started.message)
    expect(argv).toEqual(['--mode', 'rpc', ...NO_TOOLS])
    expect(manager.reply(started.sessionId)).toBeNull()
    const answer = (text: string) =>
      rpc.stdout.write(
        `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":${JSON.stringify(text)}}}\n{"type":"agent_settled","aborted":false}\n`,
      )
    answer('[]')
    await vi.advanceTimersByTimeAsync(0)
    expect(manager.reply(started.sessionId)).toBe('[]')
    // Kept past the usual window, and each answer is that turn's alone.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(rpc.wasKilled()).toBe(false)
    await manager.message(started.sessionId, 'second')
    answer('[{"startIndex":0}]')
    await vi.advanceTimersByTimeAsync(0)
    expect(manager.reply(started.sessionId)).toBe('[{"startIndex":0}]')
    await manager.stop(started.sessionId)
    expect(manager.reply(started.sessionId)).toBeNull()
    await manager.leave()
  })

  it('takes no tools or keep for Claude Code, and reads an answer of a Pi run only', async () => {
    const launches: unknown[] = []
    const table = agentCapabilities({
      sessions: { launch: async () => ({ ok: true, sessionId: 'claude' }) } as never,
      own: { has: () => false } as never,
      jobs: { has: () => false, sessions: () => [] } as never,
      fenced: {} as never,
      defaultProvider: async () => 'claude',
      providers: [] as never,
      terminals: {} as never,
      liveRemote: () => 'owner/vault',
      commitNow: async () => {},
      pi: {
        sessions: () => [
          { id: 'pi123456', provider: 'pi' as const, name: 'run', state: 'idle' as const },
        ],
        launch: async (args) => {
          launches.push(args)
          return { ok: true, sessionId: 'pi123456' }
        },
        message: async () => {},
        reply: () => '[]',
        stop: async () => ({ ok: true as const }),
      },
    })
    const ctx = { remote: 'owner/vault' } as CapabilityContext
    const launch = table['agent.launch'] as {
      params(raw: unknown): unknown
      run(ctx: CapabilityContext, args: never): Promise<unknown>
    }
    const reply = table['agent.reply'] as typeof launch
    expect(() => launch.params({ name: 'x', prompt: 'y', tools: 'none' })).toThrow(/Pi run/)
    expect(() => launch.params({ name: 'x', prompt: 'y', provider: 'pi', tools: 'all' })).toThrow()
    await launch.run(
      ctx,
      launch.params({ name: 'x', prompt: 'y', provider: 'pi', tools: 'none', keep: true }) as never,
    )
    expect(launches).toEqual([{ name: 'x', prompt: 'y', noTools: true, keep: true }])
    await expect(reply.run(ctx, reply.params({ session: 'pi123456' }) as never)).resolves.toEqual({
      output: '[]',
    })
    await expect(reply.run(ctx, reply.params({ session: 'other' }) as never)).rejects.toMatchObject(
      {
        code: 'NOT_FOUND',
      },
    )
  })

  it('uses the sanitized environment for managed RPC Pi', async () => {
    const previousManifest = process.env.PI_WORKTREE_SESSION_MANIFEST
    const previousModel = process.env.PI_MODEL
    process.env.PI_WORKTREE_SESSION_MANIFEST = '/tmp/parent-manifest.json'
    process.env.PI_MODEL = 'parent-model'
    const rpc = fake()
    let childEnv: NodeJS.ProcessEnv | undefined
    const manager = background({
      bin: () => '/usr/bin/pi',
      binDir: () => '/holi/bin',
      spawn: (_bin, _args, options) => {
        childEnv = options.env
        return rpc.child
      },
      bracket: () => {},
      changed: () => {},
    })
    try {
      manager.setVault('owner/vault', '/vault')
      await manager.launch({ name: 'x', prompt: 'x' })
      expect(childEnv?.PI_WORKTREE_SESSION_MANIFEST).toBeUndefined()
      expect(childEnv?.PI_MODEL).toBeUndefined()
      expect(childEnv?.PI_CODING_AGENT_DIR).toBe(process.env.PI_CODING_AGENT_DIR)
      expect(childEnv?.PATH).toContain(join('/holi/bin', 'fallback'))
      await manager.leave()
    } finally {
      if (previousManifest === undefined) delete process.env.PI_WORKTREE_SESSION_MANIFEST
      else process.env.PI_WORKTREE_SESSION_MANIFEST = previousManifest
      if (previousModel === undefined) delete process.env.PI_MODEL
      else process.env.PI_MODEL = previousModel
    }
  })

  it('reports process startup failures and aborts live jobs when the vault leaves', async () => {
    const startupFailure = background({
      bin: () => '/usr/bin/pi',
      spawn: () => {
        throw new Error('spawn failed')
      },
      bracket: () => {},
      changed: () => {},
    })
    startupFailure.setVault('owner/vault', '/vault')
    await expect(startupFailure.launch({ name: 'x', prompt: 'x' })).resolves.toMatchObject({
      ok: false,
      message: 'Could not start Pi: Error: spawn failed',
    })

    const rpc = fake()
    const brackets: string[] = []
    const active = background({
      bin: () => '/usr/bin/pi',
      spawn: () => rpc.child,
      bracket: (_id, edge) => brackets.push(edge),
      changed: () => {},
    })
    active.setVault('owner/vault', '/vault')
    await active.launch({ name: 'x', prompt: 'x' })
    await active.leave()
    expect(brackets).toEqual(['begin', 'forget'])
    expect(active.sessions()).toEqual([])
  })

  it('waits for child close before Stop releases the turn bracket', async () => {
    const rpc = fake(false)
    const brackets: string[] = []
    const manager = background({
      bin: () => '/usr/bin/pi',
      spawn: () => rpc.child,
      bracket: (_id, edge) => brackets.push(edge),
      changed: () => {},
    })
    manager.setVault('owner/vault', '/vault')
    const started = await manager.launch({ name: 'x', prompt: 'x' })
    if (!started.ok) throw new Error(started.message)
    let stopped = false
    const stopping = manager.stop(started.sessionId).then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)
    expect(brackets).toEqual(['begin'])
    rpc.close()
    await stopping
    expect(stopped).toBe(true)
    expect(brackets).toEqual(['begin', 'forget'])
  })

  it('waits for child close before vault leave releases the turn bracket', async () => {
    const rpc = fake(false)
    const brackets: string[] = []
    const manager = background({
      bin: () => '/usr/bin/pi',
      spawn: () => rpc.child,
      bracket: (_id, edge) => brackets.push(edge),
      changed: () => {},
    })
    manager.setVault('owner/vault', '/vault')
    await manager.launch({ name: 'x', prompt: 'x' })
    let left = false
    const leaving = manager.leave().then(() => {
      left = true
    })
    await Promise.resolve()
    expect(left).toBe(false)
    expect(brackets).toEqual(['begin'])
    expect(manager.sessions()).toHaveLength(1)
    rpc.close()
    await leaving
    expect(manager.sessions()).toEqual([])
    expect(left).toBe(true)
    expect(brackets).toEqual(['begin', 'forget'])
  })

  it('keeps failed runs visible as failures, not approval prompts', async () => {
    const rpc = fake()
    const manager = background({
      bin: () => '/usr/bin/pi',
      spawn: () => rpc.child,
      bracket: () => {},
      changed: () => {},
    })
    manager.setVault('owner/vault', '/vault')
    const started = await manager.launch({ name: 'Broken', prompt: 'do work' })
    expect(started.ok).toBe(true)
    rpc.stdout.write(
      '{"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"provider unavailable"}}\n{"type":"agent_settled","aborted":false}\n',
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect(manager.sessions()).toMatchObject([
      { state: 'idle', outcome: 'failed', error: 'provider unavailable' },
    ])
    await manager.leave()
  })

  it('rejects a pre-aborted activation without spawning or allowing a later vault', async () => {
    const activation = new AbortController()
    activation.abort()
    let spawned = 0
    const manager = background({
      activationSignal: activation.signal,
      bin: () => '/usr/bin/pi',
      spawn: () => {
        spawned++
        return fake().child
      },
      bracket: () => {},
      changed: () => {},
    })
    manager.setVault('owner/vault', '/vault')
    await expect(manager.launch({ name: 'x', prompt: 'x' })).resolves.toMatchObject({ ok: false })
    expect(spawned).toBe(0)
    await manager.leave()
    manager.setVault('other/vault', '/other')
    expect(manager.sessions()).toEqual([])
  })

  it('invalidates synchronously and joins held physical close and bracket finalization', async () => {
    const activation = new AbortController()
    const rpc = fake(false)
    const edges: string[] = []
    const enteredForget = deferred<void>()
    let finishForget!: () => void
    const forget = new Promise<void>((resolve) => {
      finishForget = resolve
    })
    const manager = background({
      activationSignal: activation.signal,
      bin: () => '/usr/bin/pi',
      spawn: () => rpc.child,
      bracket: async (_id, edge) => {
        edges.push(edge)
        if (edge === 'forget') {
          enteredForget.resolve()
          await forget
        }
      },
      changed: () => {},
    })
    manager.setVault('owner/vault', '/vault')
    const launched = await manager.launch({ name: 'x', prompt: 'x' })
    if (!launched.ok) throw new Error(launched.message)
    activation.abort()
    expect(manager.reply(launched.sessionId)).toBeNull()
    manager.setVault('other/vault', '/other')
    await expect(manager.launch({ name: 'late', prompt: 'x' })).resolves.toMatchObject({
      ok: false,
    })
    let left = false
    const leaving = manager.leave().then(() => {
      left = true
    })
    await Promise.resolve()
    expect(left).toBe(false)
    rpc.close()
    await enteredForget.promise
    expect(edges).toContain('forget')
    expect(left).toBe(false)
    finishForget()
    await leaving
    expect(left).toBe(true)
    expect(edges.filter((edge) => edge === 'forget')).toHaveLength(1)
    await expect(manager.leave()).resolves.toBeUndefined()
  })

  it('suppresses late stats and completion after activation abort', async () => {
    const activation = new AbortController()
    const rpc = fake(true, false)
    let publications = 0
    const manager = background({
      activationSignal: activation.signal,
      bin: () => '/usr/bin/pi',
      spawn: () => rpc.child,
      bracket: () => {},
      changed: () => {
        publications++
      },
    })
    manager.setVault('owner/vault', '/vault')
    const launched = await manager.launch({ name: 'x', prompt: 'x' })
    if (!launched.ok) throw new Error(launched.message)
    rpc.stdout.write('{"type":"agent_settled","aborted":false}\n')
    await Promise.resolve()
    await Promise.resolve()
    const stats = rpc.commands.find((command) => command.type === 'get_session_stats')
    expect(stats).toBeDefined()
    const beforeAbort = publications
    activation.abort()
    await manager.leave()
    rpc.stdout.write(
      JSON.stringify({
        type: 'response',
        id: stats?.id,
        command: 'get_session_stats',
        success: true,
        data: { tokens: { input: 100, output: 100, total: 200 }, contextUsage: { percent: 90 } },
      }) + '\n',
    )
    await Promise.resolve()
    expect(publications).toBe(beforeAbort)
    expect(manager.reply(launched.sessionId)).toBeNull()
    expect(manager.sessions()).toEqual([])
  })

  it('isolates overlapping turn finalizers and stop drains the superseded turn', async () => {
    vi.useFakeTimers()
    const rpc = fake()
    let releaseFirst!: () => void
    let enteredFirst!: () => void
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve
    })
    const firstFinalizer = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let ends = 0
    const manager = background({
      bin: () => '/usr/bin/pi',
      spawn: () => rpc.child,
      bracket: async (_id, edge) => {
        if (edge !== 'end') return
        ends++
        if (ends === 1) {
          enteredFirst()
          await firstFinalizer
        }
      },
      changed: () => {},
    })
    manager.setVault('owner/vault', '/vault')
    const launched = await manager.launch({ name: 'x', prompt: 'first' })
    if (!launched.ok) throw new Error(launched.message)
    const answer = (text: string) =>
      rpc.stdout.write(
        `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":${JSON.stringify(text)}}}\n{"type":"agent_settled","aborted":false}\n`,
      )

    answer('old reply')
    await vi.advanceTimersByTimeAsync(0)
    await firstEntered
    await expect(manager.message(launched.sessionId, 'second')).resolves.toBeUndefined()
    answer('new reply')
    await vi.advanceTimersByTimeAsync(0)
    expect(manager.reply(launched.sessionId)).toBe('new reply')
    expect(manager.sessions()[0]?.outcome).toBe('completed')
    await vi.advanceTimersByTimeAsync(29_999)
    expect(manager.sessions()).toHaveLength(1)

    let stopped = false
    const stopping = manager.stop(launched.sessionId).then(() => {
      stopped = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(stopped).toBe(false)
    releaseFirst()
    await stopping
    expect(stopped).toBe(true)
    expect(ends).toBe(2)
    await manager.leave()
  })

  it('retains a failed finalizer without contaminating another job', async () => {
    const children = [fake(), fake()]
    const begun: string[] = []
    let childIndex = 0
    const manager = background({
      bin: () => '/usr/bin/pi',
      spawn: () => children[childIndex++]!.child,
      bracket: async (id, edge) => {
        if (edge === 'begin') begun.push(id)
        if (edge === 'end' && id === begun[0]) throw new Error('first finalizer failed')
      },
      changed: () => {},
    })
    manager.setVault('owner/vault', '/vault')
    const first = await manager.launch({ name: 'first', prompt: 'first' })
    const second = await manager.launch({ name: 'second', prompt: 'second' })
    if (!first.ok || !second.ok) throw new Error('expected both Pi jobs to launch')
    const answer = (rpc: ReturnType<typeof fake>, text: string) =>
      rpc.stdout.write(
        `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":${JSON.stringify(text)}}}\n{"type":"agent_settled","aborted":false}\n`,
      )
    answer(children[0]!, 'first reply')
    answer(children[1]!, 'second reply')
    await vi.waitFor(() => {
      expect(manager.reply(first.sessionId)).toBe('first reply')
      expect(manager.reply(second.sessionId)).toBe('second reply')
    })
    await expect(manager.leave()).rejects.toThrow(/Pi background runs failed to drain/)
  })

  it('rejects launches without a vault or installed Pi and isolates jobs on leave', async () => {
    const manager = background({
      bin: () => null,
      bracket: () => {},
      changed: () => {},
    })
    expect(await manager.launch({ name: 'x', prompt: 'x' })).toMatchObject({ ok: false })
    manager.setVault('owner/vault', '/vault')
    expect(await manager.launch({ name: 'x', prompt: 'x' })).toMatchObject({ ok: false })
    await manager.leave()
    expect(manager.sessions()).toEqual([])
  })
})
