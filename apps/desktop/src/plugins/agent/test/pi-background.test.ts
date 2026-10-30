import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { PiChild } from '../main/pi/rpc'
import { createPiBackground } from '../main/pi/background'
import { agentCapabilities } from '../main/host/capabilities'
import type { CapabilityContext } from '../../../main/capabilities/registry'

function fake() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const commands: Record<string, unknown>[] = []
  stdin.on('data', (data: Buffer) => {
    for (const line of data.toString().trim().split('\n')) if (line) commands.push(JSON.parse(line))
  })
  const child: PiChild = {
    stdin,
    stdout,
    stderr,
    once() {
      return this
    },
    kill() {
      return true
    },
  }
  return { child, stdout, commands }
}

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
    expect(calls).toEqual(['claude', 'pi'])
  })
  it('refuses TUI attach, restart, and duplicate for managed Pi sessions', async () => {
    const pi = {
      sessions: () => [{ id: 'pi123456', provider: 'pi', name: 'run', state: 'working' }],
      launch: async () => ({ ok: true, sessionId: 'pi123456' }),
      message: async () => {},
      stop: async () => ({ ok: true }),
    }
    const table = agentCapabilities({
      sessions: {
        open: async () => ({ ok: true }),
        respawn: async () => ({ ok: true }),
        duplicate: async () => ({ ok: true }),
      } as never,
      own: { has: () => false } as never,
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

  it('launches one managed RPC job, brackets turns, delivers follow-ups and stops', async () => {
    const rpc = fake()
    const brackets: string[] = []
    const manager = createPiBackground({
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
    expect(manager.sessions()).toMatchObject([{ id, state: 'idle' }])
    await manager.message(id, 'Follow up')
    expect(rpc.commands.at(-1)).toMatchObject({ type: 'prompt', message: 'Follow up' })
    await expect(manager.stop(id)).resolves.toMatchObject({ ok: true })
    await manager.leave()
    expect(brackets).toEqual(['begin', 'end', 'begin', 'end'])
    expect(manager.sessions()).toEqual([])
  })

  it('reports process startup failures and aborts live jobs when the vault leaves', async () => {
    const startupFailure = createPiBackground({
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
    const active = createPiBackground({
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

  it('rejects launches without a vault or installed Pi and isolates jobs on leave', async () => {
    const manager = createPiBackground({
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
