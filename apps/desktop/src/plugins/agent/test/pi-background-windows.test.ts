import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UnconfirmedOwnedProgramError, type OwnedCompletion } from '../../../main/plugin-api'
import { createPiBackground } from '../main/pi/background'

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

describe('pi-background Windows integration', () => {
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
        expect(bracket.mock.calls).toEqual([[id, 'begin']])
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
          expect(manager.sessions()).toMatchObject([{ id, state: 'working' }])
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
    expect(manager.sessions()).toMatchObject([{ id, state: 'working' }])

    rpc.exit()
    const rejected = vi.fn()
    void manager.message(id, 'not admitted').catch(rejected)
    await vi.advanceTimersByTimeAsync(0)
    expect(rejected).toHaveBeenCalledExactlyOnceWith(
      new Error('Pi RPC process exited before the follow-up'),
    )
    expect(manager.sessions()).toMatchObject([{ id, state: 'working' }])
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
})
