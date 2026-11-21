import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { resolveVaultSettings } from '@holi/shared'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createCapabilityRegistry } from '../../../main/capabilities/registry'
import { createPluginHost, type OpenVault } from '../../../main/plugin-host/host'
import {
  spawnOwnedProgram,
  UnconfirmedOwnedProgramError,
  type CapabilityContext,
  type OwnedCompletion,
  type PluginCtx,
} from '../../../main/plugin-api'
import { AGENT_INFO } from '../info'
import { harnessCapabilities } from '../main/harness/capabilities'
import type { HarnessRegistry } from '../main/harness/registry'
import { createAgentProbeOwner } from '../main/probe-owner'
import { versionCapabilities } from '../main/version'

vi.mock('../../../main/plugin-api', async (actual) => ({
  ...(await actual<typeof import('../../../main/plugin-api')>()),
  spawnOwnedProgram: vi.fn(),
}))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.useRealTimers()
  vi.mocked(spawnOwnedProgram).mockReset()
})

function settingsTestCaps(root: string, probes: ReturnType<typeof createAgentProbeOwner>) {
  return harnessCapabilities({
    registry: {
      get: () => ({ env: {}, test: ['--version'] }),
      resolve: () => 'tool',
    } as unknown as HarnessRegistry,
    probes,
    file: 'agent-harnesses.json',
    root: () => root,
    changed() {},
  })
}

function activation() {
  const controller = new AbortController()
  const probes = createAgentProbeOwner(controller.signal)
  const ctx = { remote: 'fixture/vault', root: '/vault' } as CapabilityContext
  const caps = settingsTestCaps(ctx.root, probes)
  const runVersion = vi.fn(async () => '2.1.312 (Claude Code)\n')
  const version = versionCapabilities({
    holi: 'test',
    probes,
    claudeBin: () => 'tool',
    run: runVersion,
  })
  return {
    controller,
    stop: probes.stop,
    test: () => caps['agent.harnessTest'].run(ctx, { id: 'aider' }),
    version: () => version['agent.version'].run(ctx, {}),
    runVersion,
  }
}

function start(receipt = true, owner: { test(): Promise<unknown> } = activation()) {
  let resolve!: (proof: OwnedCompletion) => void
  let reject!: (error: unknown) => void
  const proof = new Promise<OwnedCompletion>((yes, no) => {
    resolve = yes
    reject = no
  })
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const kill = vi.fn(() => true)
  const child = Object.assign(new ChildProcess(), {
    ...(receipt ? { ownedCompletion: proof } : {}),
    stdout,
    stderr,
    kill,
  })
  vi.mocked(spawnOwnedProgram).mockReturnValueOnce(child)
  const answer = owner.test()
  const settled = vi.fn()
  void answer.then(settled, settled)
  const pending = async () => {
    for (let step = 0; step < 10; step++) await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
  }
  const eof = () => {
    stdout.end()
    stderr.end()
  }
  const exit = (code: number | null) => {
    Object.defineProperty(child, 'exitCode', { value: code, configurable: true })
    child.emit('exit', code, null)
  }
  const close = (code: number | null) => {
    exit(code)
    eof()
    child.emit('close', code, null)
  }
  return {
    child,
    stdout,
    stderr,
    answer,
    settled,
    pending,
    kill,
    resolve,
    reject,
    eof,
    exit,
    close,
  }
}

test.each(['output', 'proof'] as const)('Settings Test joins %s first', async (first) => {
  const f = start()
  f.stdout.write('version\n')
  f.exit(0)
  if (first === 'output') f.close(0)
  else f.resolve('empty')
  await f.pending()
  if (first === 'output') f.resolve('empty')
  else f.eof()
  await expect(f.answer).resolves.toEqual({ ok: true, output: 'version\n' })
})

test('Settings Test reports a supported no-spawn fact as a known launch failure', async () => {
  const f = start()
  f.resolve('not-started')
  f.child.emit('error', new Error('no such executable'))
  await f.pending()
  f.close(null)
  await expect(f.answer).resolves.toMatchObject({ ok: false, message: 'no such executable' })
  expect(f.kill).not.toHaveBeenCalled()
})

test('a command abort with EMPTY is a known command error, not an ownership failure', async () => {
  const owner = activation()
  const f = start(true, owner)
  const signal = AbortSignal.abort()
  const abort = Object.assign(new Error('Aborted', { cause: signal.reason }), {
    name: 'AbortError',
    code: 'ABORT_ERR',
  })
  f.child.emit('error', abort)
  f.close(1)
  f.resolve('empty')
  await expect(f.answer).resolves.toMatchObject({ ok: false, message: abort.message })
  const next = start(true, owner)
  next.close(0)
  next.resolve('empty')
  await expect(next.answer).resolves.toMatchObject({ ok: true })
  await expect(owner.stop()).resolves.toBeUndefined()
})

test.each(['missing', 'rejected'] as const)(
  'Settings Test rejects %s proof without waiting on held stdout',
  async (kind) => {
    const f = start(kind !== 'missing')
    const first = new Error('first command error')
    f.child.emit('error', first)
    const lost = new UnconfirmedOwnedProgramError(new Error('lost receipt'), { revoke: vi.fn() })
    if (kind === 'rejected') {
      f.reject(lost)
      await expect(f.answer).rejects.toMatchObject({
        cause: lost.cause,
        lease: lost.lease,
        commandError: first,
      })
    } else await expect(f.answer).rejects.toBeInstanceOf(UnconfirmedOwnedProgramError)
    f.close(0)
  },
)

test('a late proof fault poisons only the admitting activation and joins one lease on stop', async () => {
  vi.useFakeTimers()
  const a = activation()
  const f = start(true, a)
  a.controller.abort()
  const stopping = a.stop()
  const stopped = vi.fn()
  void stopping.then(stopped, stopped)
  expect(a.stop()).toBe(stopping)
  await f.pending()
  expect(stopped).not.toHaveBeenCalled()

  // Same remote, root and harness name, but a distinct context.
  const b = activation()
  const next = start(true, b)
  next.close(0)
  next.resolve('empty')
  await expect(next.answer).resolves.toEqual({ ok: true, output: '' })

  let finishRevoke!: () => void
  const revoked = new Promise<void>((resolve) => (finishRevoke = resolve))
  const lease = { revoke: vi.fn(() => revoked) }
  const lost = new UnconfirmedOwnedProgramError(new Error('lost receipt'), lease)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(f.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
  f.reject(lost) // No child close or output end; fail now, not at the kill grace.
  await expect(f.answer).rejects.toBe(lost)
  await expect(a.test()).rejects.toBe(lost)
  await expect(a.version()).rejects.toBe(lost)
  expect(spawnOwnedProgram).toHaveBeenCalledTimes(2)
  expect(a.runVersion).not.toHaveBeenCalled()
  await expect(b.version()).resolves.toEqual({ holi: 'test', claudeCode: '2.1.312' })
  await expect(b.stop()).resolves.toBeUndefined()

  expect(lease.revoke).toHaveBeenCalledOnce()
  expect(stopped).not.toHaveBeenCalled()
  finishRevoke()
  await expect(stopping).rejects.toBe(lost)
  await expect(a.stop()).rejects.toBe(lost)
  expect(lease.revoke).toHaveBeenCalledOnce()
  expect(f.child.listenerCount('close')).toBe(0)
  expect(f.child.listenerCount('exit')).toBe(0)
  for (const stream of [f.stdout, f.stderr]) {
    expect(stream.listenerCount('data')).toBe(0)
    expect(stream.listenerCount('close')).toBe(0)
    expect(stream.listenerCount('error')).toBe(1) // Public join's stateless late-error sink.
  }
  f.close(0)
  await vi.advanceTimersByTimeAsync(6_000)
  expect(f.settled).toHaveBeenCalledExactlyOnceWith(lost)
  expect(f.kill).toHaveBeenCalledOnce()
})

test.each(['leave', 'reconcile', 'shutdown'] as const)(
  '%s joins the admitting plugin context’s original failure and lease',
  async (operation) => {
    const registry = createCapabilityRegistry()
    const vault: OpenVault = {
      remote: 'fixture/vault',
      root: '/vault',
      pause() {},
      resume() {},
      drainSync: async () => {},
      commitNow: async () => '',
      repo: { head: async () => '' },
    }
    let context!: PluginCtx
    const activate = vi.fn((ctx: PluginCtx) => {
      context = ctx
      const probes = createAgentProbeOwner(ctx.activationSignal)
      ctx.register(['agent'], settingsTestCaps(ctx.root, probes))
      return probes.stop
    })
    const host = createPluginHost({
      registry,
      plugins: [{ info: AGENT_INFO, activate }],
      active: () => null,
      rootFor: async () => vault.root,
      userData: '/data',
      coreSeeds: [],
      readSettings: async () =>
        resolveVaultSettings({ app: null, appLocal: null, plugins: null, pluginsLocal: null }, [
          AGENT_INFO,
        ]),
      events: { send() {}, listen: () => () => {}, liveRemote: () => null },
      route: () => () => {},
      frameOrigin: () => () => {},
      openAppDoor: () => {
        throw new Error('unused')
      },
      binDir: () => '/bin',
      githubToken: () => null,
      notify: () => false,
      focused: () => false,
    })
    await host.reconcile(vault, 'open')
    const ctx = { remote: vault.remote, root: vault.root } as CapabilityContext
    const f = start(true, {
      test: () => registry.run('agent.harnessTest', 'ui', ctx, { id: 'aider' }),
    })
    if (operation === 'reconcile') context.invalidateActivation()
    const stop =
      operation === 'leave'
        ? host.stop(vault.remote)
        : operation === 'shutdown'
          ? host.stopAll()
          : host.reconcile(vault, 'settings')
    const result = stop.catch((error: unknown) => error)
    expect(context.activationSignal.aborted).toBe(true)
    const lease = { revoke: vi.fn(async () => {}) }
    const lost = new UnconfirmedOwnedProgramError(new Error('lost receipt after revoke'), lease)
    f.reject(lost)
    await expect(f.answer).rejects.toBe(lost)
    const leaves = (error: unknown): unknown[] =>
      error instanceof AggregateError ? error.errors.flatMap(leaves) : [error]
    expect(leaves(await result)).toContain(lost)
    expect(leaves(await host.stop(vault.remote).catch((error: unknown) => error))).toContain(lost)
    expect(lease.revoke).toHaveBeenCalledOnce()
    expect(activate).toHaveBeenCalledOnce()
    f.close(null)
  },
)

test.each(['timeout', 'over-limit'] as const)(
  'Settings Test only claims %s stopped the command after EMPTY',
  async (kind) => {
    vi.useFakeTimers()
    const f = start()
    if (kind === 'timeout') await vi.advanceTimersByTimeAsync(5_000)
    else f.stdout.write(Buffer.alloc(256 * 1024))
    expect(f.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
    f.close(0)
    await f.pending()
    f.resolve('empty')
    await expect(f.answer).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/Holi stopped it/),
    })
  },
)
