import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NO_TOOLS, type PiChild } from '../main/pi/rpc'
import { createPiBackground } from '../main/pi/background'
import { agentCapabilities } from '../main/host/capabilities'
import type { CapabilityContext } from '../../../main/capabilities/registry'
import { inspectPosixOwnership, ownedProcessDrain } from '../../../main/plugin-api'
import { posixFixtureLedger } from '../../../../test/fixtures/posix-fixture-ledger'
import { join } from 'node:path'
import { setImmediate as tick } from 'node:timers/promises'

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
  let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
  let onClose: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
  let killed = false
  let exited = false
  const exit = (code: number | null, signal: NodeJS.Signals | null) => {
    exited = true
    onExit?.(code, signal)
  }
  function closeWithOutput(code: number | null, signal: NodeJS.Signals | null) {
    if (stdout.readableEnded || stdout.destroyed) onClose?.(code, signal)
    else {
      stdout.once('end', () => onClose?.(code, signal))
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
      if (event === 'exit') onExit = listener as typeof onExit
      else if (event === 'close') onClose = listener as typeof onClose
      return this
    },
    kill() {
      killed = true
      exit(null, 'SIGTERM')
      if (autoClose) closeWithOutput(null, 'SIGTERM')
      return true
    },
  }
  return {
    child,
    stdout,
    commands,
    exit: () => {
      exit(0, null)
      closeWithOutput(0, null)
    },
    rootExit: () => exit(0, null),
    close: () => closeWithOutput(null, null),
    childCloseOnly: () => onClose?.(null, null),
    wasKilled: () => killed,
  }
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
    const manager = createPiBackground({
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
    const manager = createPiBackground({
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
    const manager = createPiBackground({
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

  it('never probes or signals a reused PID when a successfully drained run expires', async () => {
    vi.useFakeTimers()
    const rpc = fake()
    const pid = 4242
    let currentOwner = 'Pi'
    const probe = vi.fn(() => currentOwner)
    const signal = vi.fn()
    const drain = vi.fn(async () => {
      if (probe() === 'Pi') signal(pid)
    })
    const child = Object.assign(rpc.child, { pid, [ownedProcessDrain]: { drain } })
    const manager = createPiBackground({
      bin: () => '/usr/bin/pi',
      spawn: () => child,
      bracket: () => {},
      changed: () => {},
    })
    manager.setVault('owner/vault', '/vault')
    try {
      await manager.launch({ name: 'retained', prompt: 'first' })
      rpc.stdout.write('{"type":"agent_settled","aborted":false}\n')
      await vi.advanceTimersByTimeAsync(0)
      expect(manager.sessions()[0]?.outcome).toBe('completed')
      rpc.exit()
      await vi.advanceTimersByTimeAsync(0)
      expect(drain).toHaveBeenCalledTimes(1)
      currentOwner = 'unrelated'
      probe.mockClear()
      signal.mockClear()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(manager.sessions()).toEqual([])
      expect(drain).toHaveBeenCalledTimes(1)
      expect(probe).not.toHaveBeenCalled()
      expect(signal).not.toHaveBeenCalled()
      expect(rpc.wasKilled()).toBe(false)
    } finally {
      await manager.leave()
    }
  })

  it('runs a tool-less run kept between turns, whose last answer can be read', async () => {
    vi.useFakeTimers()
    const rpc = fake()
    let argv: string[] = []
    const manager = createPiBackground({
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
    const manager = createPiBackground({
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
    const failure = Object.assign(new Error('spawn failed'), { code: 'ENOENT' })
    const startupFailure = createPiBackground({
      bin: () => '/usr/bin/pi',
      spawn: () => {
        throw failure
      },
      bracket: () => {},
      changed: () => {},
    })
    startupFailure.setVault('owner/vault', '/vault')
    await expect(startupFailure.launch({ name: 'x', prompt: 'x' })).rejects.toBe(failure)
    await expect(startupFailure.leave()).rejects.toBe(failure)

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

  it.each(['stop', 'follow-up', 'expiry'] as const)(
    'retains a Pi session after cleanup rejects during %s',
    async (route) => {
      vi.useFakeTimers()
      const rpc = fake(false)
      const failure = new Error('physical receipt rejected')
      const drain = vi.fn(async () => {
        throw failure
      })
      const manager = createPiBackground({
        bin: () => 'pi',
        spawn: () => Object.assign(rpc.child, { [ownedProcessDrain]: { drain } }),
        bracket: () => {},
        changed: () => {},
      })
      const claudeStop = vi.fn()
      const capability = agentCapabilities({
        pi: manager,
        jobs: { has: () => false },
        own: { has: () => false },
        sessions: { stop: claudeStop },
        liveRemote: () => 'owner/vault',
      } as never)['agent.stop'] as {
        run(ctx: CapabilityContext, args: { id: string }): Promise<unknown>
      }
      manager.setVault('owner/vault', '/vault')
      const launched = await manager.launch({ name: 'x', prompt: 'go' })
      if (!launched.ok) throw new Error(launched.message)
      const id = launched.sessionId
      const stop = () => capability.run({ remote: 'owner/vault' } as CapabilityContext, { id })
      if (route !== 'stop') {
        rpc.stdout.write('{"type":"agent_settled","aborted":false}\n')
        await vi.advanceTimersByTimeAsync(0)
        rpc.exit()
      }
      if (route === 'stop') await expect(stop()).rejects.toBe(failure)
      if (route === 'follow-up') await expect(manager.message(id, 'again')).rejects.toBe(failure)
      if (route === 'expiry') await vi.advanceTimersByTimeAsync(30_000)
      expect(manager.sessions()).toMatchObject([{ id, provider: 'pi' }])
      manager.setVault('other/vault', '/other')
      expect(manager.reply(id)).toBeNull()
      await expect(manager.stop(id)).resolves.toMatchObject({ ok: false })
      manager.setVault('owner/vault', '/vault')
      await expect(stop()).rejects.toBe(failure)
      expect(claudeStop).not.toHaveBeenCalled()
      const left = manager.leave()
      await expect(left).rejects.toBe(failure)
      expect(manager.leave()).toBe(left)
      expect(drain).toHaveBeenCalledOnce()
    },
  )

  it.each(['held close', 'rejected drain'] as const)(
    'joins Pi spawned during activation invalidation: %s',
    async (mode) => {
      const activation = new AbortController()
      const rpc = fake(false)
      const failure = new Error('late drain rejected')
      const drain = vi.fn(async () => {
        if (mode === 'rejected drain') throw failure
      })
      const bracket = vi.fn()
      const changed = vi.fn()
      const manager = createPiBackground({
        bin: () => 'pi',
        spawn: () => {
          activation.abort()
          return Object.assign(rpc.child, { [ownedProcessDrain]: { drain } })
        },
        activationSignal: activation.signal,
        bracket,
        changed,
      })
      manager.setVault('owner/vault', '/vault')
      await expect(manager.launch({ name: 'x', prompt: 'go' })).resolves.toMatchObject({
        ok: false,
      })
      const leaving = manager.leave()
      if (mode === 'rejected drain') await expect(leaving).rejects.toBe(failure)
      else {
        const left = vi.fn()
        void leaving.then(left)
        await new Promise((resolve) => setImmediate(resolve))
        expect(left).not.toHaveBeenCalled()
        rpc.close()
        await leaving
      }
      expect(manager.leave()).toBe(leaving)
      expect(drain).toHaveBeenCalledOnce()
      expect(bracket).not.toHaveBeenCalled()
      expect(changed).not.toHaveBeenCalled()
    },
  )

  it('does not turn fake startup cleanup into non-admission proof', async () => {
    const failure = Object.assign(new Error('ambiguous launch'), {
      code: 'ABORT_ERR',
      cleanup: Promise.resolve(),
    })
    const ownershipRecordPath = vi.fn(() => '/not-used-by-fake')
    const manager = createPiBackground({
      bin: () => 'pi',
      spawn: () => {
        throw failure
      },
      ownershipRecordPath,
      bracket: vi.fn(),
      changed: () => {},
    })
    manager.setVault('owner/vault', '/vault')
    await expect(manager.launch({ name: 'x', prompt: 'go' })).rejects.toBe(failure)
    await expect(manager.leave()).rejects.toBe(failure)
    expect(ownershipRecordPath).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32').each(['settled', 'rejected'] as const)(
    'joins verified pre-native refusal cleanup with its ownership record: %s',
    async (mode) => {
      const ledger = await posixFixtureLedger('holi-pi-preflight-')
      const parent = mode === 'settled' ? ledger.root : join(ledger.root, 'missing-parent')
      const path = join(parent, randomUUID())
      const manager = createPiBackground({
        bin: () => '', // Core positively refuses this before native spawn.
        ownershipRecordPath: () => path,
        bracket: vi.fn(),
        changed: () => {},
      })
      manager.setVault('owner/vault', ledger.root)
      try {
        const launch = manager.launch({ name: 'x', prompt: 'go' })
        const leaving = manager.leave()
        if (mode === 'settled') {
          await expect(launch).resolves.toMatchObject({
            ok: false,
            message: expect.stringMatching(/file.*empty/),
          })
          await leaving
          expect(inspectPosixOwnership(path)).toEqual({ state: 'confirmed', proof: 'settled' })
        } else {
          await expect(launch).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_VALUE' })
          const startup: unknown = await launch.catch((error: unknown) => error)
          await expect(leaving).rejects.toMatchObject({
            errors: [startup, expect.objectContaining({ code: 'ENOENT' })],
          })
        }
      } finally {
        await ledger.remove() // No child can be admitted by this preflight.
      }
    },
  )

  it('keeps the missing-proof launch rejection on the original Pi owner', async () => {
    const rpc = fake(false)
    const manager = createPiBackground({
      bin: () => 'pi',
      spawn: () => Object.assign(rpc.child, { [ownedProcessDrain]: undefined }),
      bracket: vi.fn(),
      changed: () => {},
    })
    manager.setVault('owner/vault', '/vault')
    const launch = manager.launch({ name: 'x', prompt: 'go' })
    await expect(launch).rejects.toThrow(/ownership proof/)
    const failure: unknown = await launch.catch((error) => error)
    const [job] = manager.sessions()
    expect(job?.provider).toBe('pi')
    await expect(manager.stop(job!.id)).rejects.toBe(failure)
    await expect(manager.leave()).rejects.toBe(failure)
    expect(rpc.commands).toEqual([])
    expect(rpc.wasKilled()).toBe(false)
  })

  it('joins a failed spawn receipt and retains both original causes on rejection', async () => {
    const activation = new AbortController()
    let rejectCleanup!: (error: Error) => void
    const cleanup = new Promise<void>((_resolve, reject) => {
      rejectCleanup = reject
    })
    const startup = Object.assign(new Error('startup failed'), { cleanup })
    const failure = new Error('failed startup cleanup rejected')
    const manager = createPiBackground({
      bin: () => 'pi',
      spawn: () => {
        activation.abort()
        throw startup
      },
      activationSignal: activation.signal,
      bracket: () => {},
      changed: () => {},
    })
    manager.setVault('owner/vault', '/vault')
    const launchError = manager.launch({ name: 'x', prompt: 'go' }).catch((error) => error)
    const leaving = manager.leave()
    const left = vi.fn()
    void leaving.then(left, left)
    await new Promise((resolve) => setImmediate(resolve))
    // Reject only after observing that teardown is still waiting. Observe the
    // fixture itself on red, when the owner has not yet adopted the receipt.
    void cleanup.catch(() => {})
    rejectCleanup(failure)
    expect(left).not.toHaveBeenCalled()
    expect(await launchError).toBe(startup)
    await expect(leaving).rejects.toMatchObject({ errors: [startup, failure] })
    expect(manager.leave()).toBe(leaving)
  })

  it('waits for child close before Stop releases the turn bracket', async () => {
    const rpc = fake(false)
    const brackets: string[] = []
    const manager = createPiBackground({
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
    const manager = createPiBackground({
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
    expect(manager.sessions()).toEqual([])
    rpc.close()
    await leaving
    expect(left).toBe(true)
    expect(brackets).toEqual(['begin', 'forget'])
  })

  it('keeps failed runs visible as failures, not approval prompts', async () => {
    const rpc = fake()
    const manager = createPiBackground({
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
    const manager = createPiBackground({
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
    let finishForget!: () => void
    let enteredForget!: () => void
    const forget = new Promise<void>((resolve) => {
      finishForget = resolve
    })
    const forgetting = new Promise<void>((resolve) => {
      enteredForget = resolve
    })
    const manager = createPiBackground({
      activationSignal: activation.signal,
      bin: () => '/usr/bin/pi',
      spawn: () => rpc.child,
      bracket: async (_id, edge) => {
        edges.push(edge)
        if (edge === 'forget') {
          enteredForget()
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
    expect(edges).toEqual(['begin'])
    rpc.close()
    await forgetting
    expect(left).toBe(false)
    finishForget()
    await leaving
    expect(left).toBe(true)
    expect(edges.filter((edge) => edge === 'forget')).toHaveLength(1)
    await expect(manager.leave()).resolves.toBeUndefined()
  })

  it.each(['settled', 'stats'] as const)(
    'defers exiting Pi publication and finalization until EOF after late %s',
    async (late) => {
      const rpc = fake(false, false)
      const drain = vi.fn(async () => {})
      const bracket = vi.fn()
      const changed = vi.fn()
      const manager = createPiBackground({
        bin: () => 'pi',
        spawn: () => Object.assign(rpc.child, { [ownedProcessDrain]: { drain } }),
        bracket,
        changed,
      })
      manager.setVault('owner/vault', '/vault')
      const launched = await manager.launch({ name: 'x', prompt: 'go' })
      if (!launched.ok) throw new Error(launched.message)
      const id = launched.sessionId
      try {
        if (late === 'stats') rpc.stdout.write('{"type":"agent_settled"}\n')
        const updates = changed.mock.calls.length
        rpc.rootExit()
        expect(drain).toHaveBeenCalledOnce()
        if (late === 'settled') rpc.stdout.write('{"type":"agent_settled"}\n')
        else {
          const request = rpc.commands.at(-1)
          expect(request?.type).toBe('get_session_stats')
          rpc.stdout.write(
            JSON.stringify({
              type: 'response',
              id: request?.id,
              success: true,
              data: { tokens: { total: 9 } },
            }) + '\n',
          )
        }
        await tick()
        expect(manager.reply(id)).toBeNull()
        expect(manager.sessions()[0]).toMatchObject({ state: 'working' })
        expect(bracket.mock.calls).toEqual([[id, 'begin']])
        expect(changed).toHaveBeenCalledTimes(updates)
        rpc.stdout.end(
          '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"final reply"}}',
        )
        await tick()
        expect(manager.reply(id)).toBeNull()
        rpc.close()
        await vi.waitFor(() => expect(manager.reply(id)).toBe('final reply'))
        expect(bracket.mock.calls).toEqual([
          [id, 'begin'],
          [id, 'end'],
        ])
        expect(manager.sessions()[0]).toMatchObject({ state: 'idle', outcome: 'completed' })
        if (late === 'stats') expect(manager.sessions()[0]?.usage).toEqual({ total: 9 })
      } finally {
        rpc.close()
        await manager.leave()
      }
    },
  )

  it('retains the output deadline rejection through expiry, Stop and leave', async () => {
    vi.useFakeTimers()
    const rpc = fake(false)
    const drain = vi.fn(async () => {})
    const manager = createPiBackground({
      bin: () => 'pi',
      spawn: () => Object.assign(rpc.child, { [ownedProcessDrain]: { drain } }),
      bracket: vi.fn(),
      changed: () => {},
    })
    manager.setVault('owner/vault', '/vault')
    const launched = await manager.launch({ name: 'x', prompt: 'go' })
    if (!launched.ok) throw new Error(launched.message)
    const id = launched.sessionId
    rpc.stdout.write('{"type":"agent_settled"}\n')
    await vi.advanceTimersByTimeAsync(0)
    expect(manager.reply(id)).toBe('')
    rpc.childCloseOnly()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(manager.sessions()).toMatchObject([{ id }])
    const stopping = manager.stop(id)
    await expect(stopping).rejects.toThrow(/output drain timed out waiting for stdout end/)
    const failure: unknown = await stopping.catch((error: unknown) => error)
    await expect(manager.stop(id)).rejects.toBe(failure)
    await expect(manager.leave()).rejects.toBe(failure)
    expect(drain).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    rpc.stdout.destroy()
  })

  it('starts a separate turn finalization deadline after proof and output', async () => {
    vi.useFakeTimers()
    const rpc = fake(false, false)
    const drain = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 9000)))
    let rejectFinalizer!: (error: Error) => void
    const finalizer = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFinalizer = reject
        }),
    )
    const manager = createPiBackground({
      bin: () => 'pi',
      spawn: () => Object.assign(rpc.child, { [ownedProcessDrain]: { drain } }),
      bracket: (_id, edge) => (edge === 'forget' ? finalizer() : undefined),
      changed: () => {},
    })
    manager.setVault('owner/vault', '/vault')
    const launched = await manager.launch({ name: 'x', prompt: 'go' })
    if (!launched.ok) throw new Error(launched.message)
    const id = launched.sessionId
    const stopped = vi.fn()
    void manager.stop(id).then(stopped, stopped)
    await vi.advanceTimersByTimeAsync(9000)
    expect(stopped).not.toHaveBeenCalled()
    expect(finalizer).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(4000)
    rpc.stdout.end()
    await tick()
    rpc.close()
    await vi.advanceTimersByTimeAsync(4999)
    expect(finalizer).toHaveBeenCalledOnce()
    expect(stopped).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(stopped).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: expect.stringMatching(/Pi.*turn.*timed out/i) }),
    )
    const failure: unknown = stopped.mock.calls[0]?.[0]
    expect(manager.sessions()).toMatchObject([{ id }])
    expect(manager.reply(id)).toBeNull()
    await expect(manager.stop(id)).rejects.toBe(failure)
    await expect(manager.leave()).rejects.toBe(failure)
    rejectFinalizer(new Error('late finalizer rejection'))
    await vi.advanceTimersByTimeAsync(0)
    await expect(manager.leave()).rejects.toBe(failure)
    expect(drain).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['destroy', 'error'] as const)(
    'does not publish an exiting reply after stdout %s',
    async (mode) => {
      const rpc = fake(false, false)
      const bracket = vi.fn()
      const manager = createPiBackground({
        bin: () => 'pi',
        spawn: () => rpc.child,
        bracket,
        changed: () => {},
      })
      manager.setVault('owner/vault', '/vault')
      const launched = await manager.launch({ name: 'x', prompt: 'go' })
      if (!launched.ok) throw new Error(launched.message)
      const id = launched.sessionId
      rpc.stdout.write('{"type":"agent_settled"}\n')
      rpc.rootExit()
      rpc.stdout.write(
        '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"truncated"}}',
      )
      const cause = mode === 'error' ? new Error('pipe broke') : undefined
      rpc.stdout.destroy(cause)
      await tick()
      expect(manager.reply(id)).toBeNull()
      rpc.close()
      await tick()
      expect(manager.reply(id)).toBeNull()
      expect(bracket.mock.calls).toEqual([
        [id, 'begin'],
        [id, 'forget'],
      ])
      expect(manager.sessions()[0]?.outcome).toBe('failed')
      const failure: unknown = await manager.stop(id).catch((error: unknown) => error)
      if (cause) expect(failure).toBe(cause)
      else
        expect(failure).toEqual(
          expect.objectContaining({ message: expect.stringMatching(/stdout.*before.*end/i) }),
        )
      await expect(manager.stop(id)).rejects.toBe(failure)
      await expect(manager.leave()).rejects.toBe(failure)
    },
  )

  it('retains the original physical rejection without EOF or child close', async () => {
    const rpc = fake(false, false)
    const failure = new Error('could not prove drainage')
    const drain = vi.fn(async () => {
      throw failure
    })
    const bracket = vi.fn((_id: string, edge: string) =>
      edge === 'forget' ? new Promise<void>(() => {}) : undefined,
    )
    const manager = createPiBackground({
      bin: () => 'pi',
      spawn: () => Object.assign(rpc.child, { [ownedProcessDrain]: { drain } }),
      bracket,
      changed: () => {},
    })
    manager.setVault('owner/vault', '/vault')
    const launched = await manager.launch({ name: 'x', prompt: 'go' })
    if (!launched.ok) throw new Error(launched.message)
    const id = launched.sessionId
    rpc.rootExit()
    await vi.waitFor(() =>
      expect(bracket.mock.calls).toEqual([
        [id, 'begin'],
        [id, 'forget'],
      ]),
    )
    rpc.stdout.write('{"type":"agent_settled"}\n')
    expect(manager.reply(id)).toBeNull()
    for (let i = 0; i < 2; i++) await expect(manager.stop(id)).rejects.toBe(failure)
    await expect(manager.leave()).rejects.toBe(failure)
    expect(drain).toHaveBeenCalledOnce()
  })

  it('suppresses late stats and completion after activation abort', async () => {
    const activation = new AbortController()
    const rpc = fake(true, false)
    let publications = 0
    const manager = createPiBackground({
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
    const manager = createPiBackground({
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
    const failure = new Error('first finalizer failed')
    let childIndex = 0
    const manager = createPiBackground({
      bin: () => '/usr/bin/pi',
      spawn: () => children[childIndex++]!.child,
      bracket: async (id, edge) => {
        if (edge === 'begin') begun.push(id)
        if (edge === 'end' && id === begun[0]) throw failure
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
    await expect(manager.stop(first.sessionId)).rejects.toBe(failure)
    expect(manager.sessions().map(({ id }) => id)).toContain(first.sessionId)
    await expect(manager.stop(second.sessionId)).resolves.toEqual({ ok: true })
    await expect(manager.leave()).rejects.toBe(failure)
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
