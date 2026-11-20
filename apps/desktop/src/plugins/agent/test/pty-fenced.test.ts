import { spawn } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLeaseForTests } from '../../../../test/fixtures/posix-native-build'
import { nativeLoadHint, preloadNativePty } from '../../../main/terminal/pty'
import { createFencedSessions, recoverFencedScratch } from '../main/host/fenced'
import { activationOwnership } from '../main/host/ownership'
import { AgentRuntime, withPtyOwnership } from '../main/host/pty'
import { createPtySessions } from '../main/host/pty-sessions'
import { createAgentTerminals, type AgentTerminalsDeps } from '../main/host/terminals'
import type { AgentProvider } from '../main/provider'

const native = vi.hoisted(() => ({
  spawn: vi.fn(),
  preload: vi.fn(),
  prepare: vi.fn(),
  helper: '',
  directory: '',
}))
vi.mock('../../../main/posix-lease-executable', () => ({
  posixLeaseExecutable: () => native.helper,
}))
vi.mock('../../../main/plugin-api', async (original) => {
  const core = await original<typeof import('../../../main/plugin-api')>()
  return {
    ...core,
    defaultSpawnPty: Object.assign(native.spawn, { preload: native.preload }),
    preparePosixLaunch: (...[bin, args, opts]: Parameters<typeof core.preparePosixLaunch>) => {
      native.prepare()
      return core.preparePosixLaunch(bin, args, {
        ...opts,
        directory: native.directory,
        graceMs: 75,
        timeoutMs: 1000,
      })
    },
  }
})

afterEach(() => {
  vi.useRealTimers()
  native.spawn.mockReset()
  native.preload.mockReset()
  native.prepare.mockReset()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function rig(
  root: string,
  runtime: Partial<AgentTerminalsDeps>,
  release = vi.fn(async (_state: string, _signal?: AbortSignal) => {}),
  command = { bin: '/bin/sh', args: ['-c', 'exit 91'] },
  idleMs = 100,
) {
  const vault = { root, remote: 'test/vault' }
  const emit = vi.fn()
  const terminals = createAgentTerminals({ emit, log: () => {}, ...runtime })
  const provider: AgentProvider = {
    id: 'codex',
    label: 'Codex',
    notInstalled: 'not installed',
    installed: () => true,
    configure: async () => ({ dir: root }),
    terminal: () => ({
      ...command,
      env: { PATH: '/provider', MODE: 'provider' },
    }),
    capabilities: { fenced: 'sandbox' },
    release,
  }
  const bracket = vi.fn()
  const sessions = createPtySessions({
    vault,
    providers: () => [provider],
    terminals,
    bracket,
    binDir: () => null,
    onChange: () => {},
    idleMs,
  })
  const copyBack = vi.fn(async (..._args: unknown[]) => ({ written: 0, skipped: [] }))
  const scratchRoot = join(root, 'fenced')
  const ownership = activationOwnership(root, vault, new AbortController().signal)
  if (ownership) recoverFencedScratch(ownership, scratchRoot)
  const fenced = createFencedSessions({
    vault,
    scratchRoot,
    ...(ownership && { ownership }),
    own: sessions,
    copyBack,
    log: () => {},
  })
  const start = () =>
    fenced.start({ provider, name: 'fenced', prompt: 'go', scope: { read: [], write: [] } })
  return {
    terminals,
    sessions,
    fenced,
    start,
    scratchRoot,
    copyBack,
    release,
    bracket,
    emit,
    vault,
  }
}

it.skipIf(process.platform === 'win32')(
  'rejects a native module-load failure before preparing a launch or retaining scratch',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'holi-pty-fenced-'))
    const loadError = new Error('node-pty: wrong NODE_MODULE_VERSION')
    native.preload.mockImplementationOnce(() => {
      throw loadError
    })
    // A red run must not prepare real receipts, either.
    native.prepare.mockImplementationOnce(() => {
      throw new Error('unexpected launch preparation')
    })
    const probePid = vi.fn()
    const signal = vi.spyOn(process, 'kill')
    const t = rig(root, { probePid })
    try {
      await expect(t.start()).resolves.toEqual({ ok: false, message: loadError.message })
      expect(native.preload).toHaveBeenCalledOnce()
      expect(native.prepare).not.toHaveBeenCalled()
      expect(native.spawn).not.toHaveBeenCalled()
      expect(probePid).not.toHaveBeenCalled()
      expect(signal).not.toHaveBeenCalled()
      expect(t.terminals.list()).toEqual([])
      expect(await readdir(t.scratchRoot)).toEqual([])
      await t.terminals.closeAll()
      await t.fenced.leave()
      await expect(access(t.scratchRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      signal.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  },
)

it.skipIf(process.platform === 'win32').each(['missing', 'no execute bit'])(
  'refuses macOS spawn-helper (%s) before preparation and retires the fenced non-launch',
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'holi-pty-fenced-helper-'))
    const helper = join(root, 'resolved-debug-or-prebuild', 'spawn-helper')
    const spawn = vi.fn()
    const probePid = vi.fn()
    const signal = vi.spyOn(process, 'kill')
    const t = rig(root, { probePid })
    try {
      if (kind === 'no execute bit') {
        await mkdir(join(root, 'resolved-debug-or-prebuild'))
        await writeFile(helper, '#!/bin/sh\n', { mode: 0o600 })
        await chmod(helper, 0o600)
      }
      native.preload.mockImplementation(() =>
        preloadNativePty({
          platform: 'darwin',
          load: () => ({ spawn }),
          helperPath: () => helper,
        }),
      )
      native.prepare.mockImplementation(() => {
        throw new Error('unexpected lease allocation')
      })
      const result = await t.start()
      expect(result).toEqual({ ok: false, message: expect.stringContaining(helper) })
      if (result.ok) throw new Error('launch unexpectedly succeeded')
      expect(nativeLoadHint(new Error(result.message))).toBe(result.message)
      expect(native.prepare).not.toHaveBeenCalled()
      expect(spawn).not.toHaveBeenCalled()
      expect(probePid).not.toHaveBeenCalled()
      expect(signal).not.toHaveBeenCalled()
      expect(await readdir(t.scratchRoot)).toEqual([])
      await t.fenced.leave()
      const next = activationOwnership(root, t.vault, new AbortController().signal)!
      recoverFencedScratch(next, t.scratchRoot)
    } finally {
      signal.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  },
)

it.skipIf(process.platform === 'win32')(
  'validates raw POSIX PTY inputs before any record or native work',
  () => {
    const spawn = vi.fn()
    const allocate = vi.fn()
    const probePid = vi.fn()
    native.preload.mockImplementation(() =>
      preloadNativePty({ platform: 'linux', load: () => ({ spawn }) }),
    )
    native.prepare.mockImplementation(() => {
      throw new Error('unexpected preparation')
    })
    const runtime = new AgentRuntime({ probePid })
    const opts = { bin: '/bin/sh', args: [], cwd: '/tmp', env: {} }
    const local = (overrides: Partial<typeof opts> & { cols?: number; rows?: number }) => {
      const input = { ...opts, ...overrides }
      expect(() =>
        withPtyOwnership({ cwd: input.cwd, allocate }, () => runtime.start(input)),
      ).toThrow(/Invalid node-pty/)
      expect(runtime.failedLaunchCleanup).toBeUndefined()
    }
    local({ bin: '' })
    local({ args: ['bad\0argument'] as never[] })
    local({ cwd: '/tmp\0bad' })
    local({ env: { PATH: 'a\0b' } })
    local({ cols: Number.NaN })
    local({ rows: -1 })
    expect(allocate).not.toHaveBeenCalled()
    expect(native.prepare).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(probePid).not.toHaveBeenCalled()
  },
)

it.skipIf(process.platform === 'win32')(
  'refuses an unpublished PTY invalidated during native preflight without allocating a lease',
  () => {
    const controller = new AbortController()
    const allocate = vi.fn()
    native.preload.mockReturnValue(() => {
      controller.abort()
      return native.spawn
    })
    const runtime = new AgentRuntime({ activationSignal: controller.signal })
    const opts = { bin: '/bin/sh', args: [], cwd: '/tmp', env: {} }
    expect(() => withPtyOwnership({ cwd: opts.cwd, allocate }, () => runtime.start(opts))).toThrow(
      'The vault was left before the terminal opened.',
    )
    expect(runtime.failedLaunchCleanup).toBeUndefined()
    expect(allocate).not.toHaveBeenCalled()
    expect(native.prepare).not.toHaveBeenCalled()
    expect(native.spawn).not.toHaveBeenCalled()
  },
)

it.each(['root exit', 'explicit Stop'] as const)(
  'closes fenced turn admission at %s and joins physical proof, tail output and final copy',
  async (reason) => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'holi-pty-fenced-'))
    const physical = deferred<void>()
    const admitted = deferred<{ written: number; skipped: [] }>()
    const releaseGate = deferred<void>()
    const proof = vi.fn(() => physical.promise)
    let data!: (value: string) => void
    let publicExit!: (value: { exitCode: number }) => void
    const pty = {
      _boundClose: false,
      pid: 999_999,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: (cb: typeof data) => {
        data = cb
      },
      onExit: (cb: typeof publicExit) => {
        publicExit = cb
      },
    }
    const t = rig(
      root,
      { spawnPty: () => pty, superviseGroup: () => ({ drain: proof }) },
      vi.fn(() => releaseGate.promise),
    )
    let stopping: Promise<unknown> | undefined
    try {
      const run = await t.start()
      if (!run.ok) throw new Error(run.message)
      const attached = t.terminals.attach(run.terminalId)
      await vi.advanceTimersByTimeAsync(1)
      await attached
      t.copyBack.mockImplementationOnce(() => admitted.promise)
      t.sessions.noteTurn(run.sessionId, false) // Already admitted before the drain edge.
      await vi.waitFor(() => expect(t.copyBack).toHaveBeenCalledOnce())
      t.sessions.noteTurn(run.sessionId, true)
      await vi.advanceTimersByTimeAsync(99)
      if (reason === 'root exit') pty._boundClose = true
      else stopping = t.sessions.stop(run.sessionId)
      void stopping?.catch(() => {})
      // The natural-exit case crosses the idle deadline without a hook; the
      // explicit-close case exercises a hook before its deadline.
      if (reason === 'root exit') await vi.advanceTimersByTimeAsync(2)
      t.sessions.noteTurn(run.sessionId, false)
      t.sessions.noteTurn(run.sessionId, true)
      await vi.advanceTimersByTimeAsync(2)
      admitted.resolve({ written: 0, skipped: [] })
      await vi.advanceTimersByTimeAsync(2)
      expect(t.copyBack).toHaveBeenCalledOnce()
      expect(proof).toHaveBeenCalledOnce()
      data('terminal tail')
      expect(t.emit).toHaveBeenCalledWith('test/vault', 'pty-data', {
        id: run.terminalId,
        data: 'terminal tail',
      })
      if (reason === 'root exit') {
        physical.resolve()
        await vi.advanceTimersByTimeAsync(5)
        expect(t.copyBack).toHaveBeenCalledOnce()
        publicExit({ exitCode: 0 })
      } else {
        publicExit({ exitCode: 0 })
        await vi.advanceTimersByTimeAsync(12_000)
        expect(t.copyBack).toHaveBeenCalledOnce()
        physical.resolve()
      }
      stopping ??= t.sessions.stop(run.sessionId)
      await vi.waitFor(() => expect(t.release).toHaveBeenCalledOnce())
      expect(t.copyBack).toHaveBeenCalledTimes(2)
      expect(t.terminals.launchedFor(run.sessionId)).toBe(run.terminalId)
      expect(t.sessions.has(run.sessionId)).toBe(true)
      expect(await t.sessions.start('codex', { sessionId: run.sessionId })).toMatchObject({
        ok: false,
      })
      const again = t.sessions.stop(run.sessionId)
      releaseGate.resolve()
      await expect(Promise.all([stopping, again])).resolves.toEqual([{ ok: true }, { ok: true }])
      expect(t.sessions.has(run.sessionId)).toBe(false)
      expect(pty.kill).not.toHaveBeenCalled()
    } finally {
      admitted.resolve({ written: 0, skipped: [] })
      physical.resolve()
      publicExit?.({ exitCode: 0 })
      releaseGate.resolve()
      vi.useRealTimers()
      await stopping?.catch(() => {})
      await t.sessions.leave()
      await t.fenced.leave()
      await rm(root, { recursive: true, force: true })
    }
  },
)

it.each(['copy', 'release'] as const)(
  'preserves fenced %s failure through terminal close, repeat Stop and leave',
  async (failure) => {
    const root = await mkdtemp(join(tmpdir(), 'holi-pty-fenced-'))
    const cause = new Error(`fenced ${failure} failed`)
    let exit!: (e: { exitCode: number }) => void
    const pty = {
      pid: 999_999,
      onExit: (cb: typeof exit) => {
        exit = cb
      },
      onData() {},
      write() {},
      resize() {},
      kill() {},
    }
    const t = rig(
      root,
      { spawnPty: () => pty, superviseGroup: () => ({ drain: async () => {} }) },
      vi.fn(async (_state: string) => {
        if (failure === 'release') throw cause
      }),
    )
    if (failure === 'copy') t.copyBack.mockRejectedValueOnce(cause)
    try {
      const run = await t.start()
      if (!run.ok) throw new Error(run.message)
      exit({ exitCode: 0 })
      await expect(t.terminals.close(run.terminalId)).rejects.toBe(cause)
      await expect(t.sessions.stop(run.sessionId)).rejects.toBe(cause)
      await expect(t.sessions.stop(run.sessionId)).rejects.toBe(cause)
      await expect(t.sessions.leave()).rejects.toMatchObject({ errors: [cause] })
      expect(t.sessions.has(run.sessionId)).toBe(true)
      expect(t.sessions.sessions()).toEqual([
        expect.objectContaining({ outcome: 'failed', closed: true }),
      ])
      expect(t.terminals.launchedFor(run.sessionId)).toBe(run.terminalId)
      expect(t.release).toHaveBeenCalledTimes(failure === 'release' ? 1 : 0)
      expect(t.copyBack).toHaveBeenCalledOnce()
      expect(await readdir(t.scratchRoot)).toHaveLength(2)
      await expect(t.fenced.leave()).rejects.toMatchObject({ errors: [cause] })
    } finally {
      // This rig has no OS child; only the test owns these directories.
      await rm(root, { recursive: true, force: true })
    }
  },
)

it.skipIf(process.platform === 'win32')(
  'retains fenced scratch and the first timeout after provider release returns late',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'holi-pty-fenced-'))
    const release = deferred<void>()
    const entered = deferred<string>()
    let exit!: (e: { exitCode: number }) => void
    const pty = {
      pid: 999_999,
      onExit: (cb: typeof exit) => {
        exit = cb
      },
      onData() {},
      write() {},
      resize() {},
      kill: vi.fn(),
    }
    const proof = vi.fn(async () => {})
    const t = rig(
      root,
      { spawnPty: () => pty, superviseGroup: () => ({ drain: proof }) },
      vi.fn((state: string, signal?: AbortSignal) => {
        expect(signal).toBeInstanceOf(AbortSignal)
        entered.resolve(state)
        return release.promise
      }),
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const run = await t.start()
      if (!run.ok) throw new Error(run.message)
      exit({ exitCode: 0 })
      const state = await entered.promise
      await writeFile(join(state, 'private'), 'provider resource')
      const [scope] = await readdir(join(root, 'agent-ownership'))
      const registry = join(root, 'agent-ownership', scope!, 'fenced')
      const [link] = await readdir(registry)
      const record = join(registry, link!)
      expect(await readFile(join(record, 'caller-finalizing'), 'utf8')).toMatch(/FINALIZING\n$/)
      await expect(access(join(record, 'caller-settled'))).rejects.toMatchObject({ code: 'ENOENT' })
      await vi.advanceTimersByTimeAsync(5_000)
      const failure = await t.sessions.stop(run.sessionId).catch((error: unknown) => error)
      expect(failure).toMatchObject({ message: expect.stringMatching(/exit callbacks.*timed out/) })
      expect(t.release.mock.calls[0]?.[1]?.reason).toBe(failure)
      release.resolve()
      await vi.advanceTimersByTimeAsync(0)
      await expect(t.sessions.stop(run.sessionId)).rejects.toBe(failure)
      await expect(t.sessions.leave()).rejects.toMatchObject({ errors: [failure] })
      await expect(t.fenced.leave()).rejects.toMatchObject({ errors: [failure] })
      expect(await readdir(t.scratchRoot)).toHaveLength(2)
      expect(await readFile(join(state, 'private'), 'utf8')).toBe('provider resource')
      expect(await readdir(registry)).toEqual([link])
      expect(await readFile(join(registry, link!, 'failed'), 'utf8')).toContain(String(failure))
      expect(t.sessions.has(run.sessionId)).toBe(true)
      expect(t.sessions.sessions().some((row) => row.outcome === 'completed')).toBe(false)
      expect(proof).toHaveBeenCalledOnce()
      expect(pty.kill).not.toHaveBeenCalled()
    } finally {
      release.resolve()
      await vi.advanceTimersByTimeAsync(10_000)
      vi.clearAllTimers()
      vi.useRealTimers()
      // Paired fake adapter and proof: no operating-system PID work.
      await rm(root, { recursive: true, force: true })
    }
  },
)

it.skipIf(process.platform === 'win32').each(['cancelled startup', 'held final copy'] as const)(
  'settles a real named fenced PTY lease with %s',
  async (phase) => {
    const helper = buildLeaseForTests()
    const root = await mkdtemp(join(tmpdir(), 'holi-pty-fenced-'))
    const leases = join(root, 'receipts')
    await mkdir(leases)
    native.helper = helper.binary
    native.directory = leases
    const marker = join(root, 'provider-entered')
    let pid: number | undefined
    let journal: string | undefined
    let evidenceRead: Promise<string> | undefined
    const reaped = deferred<void>()
    void reaped.promise.catch(() => {})
    native.spawn.mockImplementationOnce((file, args, opts) => {
      // Use the real named lease and a native detached root, not a fake PID.
      journal = args[4]
      const child = spawn(file, args, {
        cwd: opts.cwd,
        env: opts.env,
        detached: true,
        stdio: 'ignore',
      })
      pid = child.pid
      child.once('error', reaped.reject)
      let onExit: ((e: { exitCode: number }) => void) | undefined
      const pty = {
        pid,
        _boundClose: false,
        onExit(cb: typeof onExit) {
          onExit = cb
        },
        onData() {},
        write() {},
        resize() {},
        kill: vi.fn(),
      }
      child.once('exit', (code) => {
        evidenceRead = readFile(journal!, 'utf8')
        void evidenceRead.catch(() => {})
        reaped.resolve()
        pty._boundClose = true
        onExit?.({ exitCode: code ?? 1 })
      })
      return pty
    })
    const copy = deferred<{ written: number; skipped: [] }>()
    const copying = deferred<string>()
    const t = rig(
      root,
      {},
      undefined,
      phase === 'cancelled startup'
        ? { bin: '/usr/bin/touch', args: [marker] }
        : { bin: '/bin/sh', args: ['-c', 'printf only-copy > output'] },
      10_000, // Let this fixture reach the exit copy, not idle-triggered turn copy.
    )
    t.copyBack.mockImplementationOnce((dir) => {
      copying.resolve(String(dir))
      return copy.promise
    })
    try {
      const run = await t.start()
      if (!run.ok) throw new Error(run.message)
      if (phase === 'held final copy') {
        const scratch = await copying.promise
        const record = dirname(dirname(dirname(journal!)))
        expect(await readFile(join(dirname(journal!), 'settled'), 'utf8')).toMatch(/SETTLED\n$/)
        expect(await readFile(join(record, 'caller-finalizing'), 'utf8')).toMatch(/FINALIZING\n$/)
        await expect(access(join(record, 'caller-settled'))).rejects.toMatchObject({
          code: 'ENOENT',
        })
        // At a virtual controller death there is no further output/copy/release
        // progress. Independently recover against exactly that durable state.
        const next = activationOwnership(root, t.vault, new AbortController().signal)!
        expect(() => recoverFencedScratch(next, t.scratchRoot)).toThrow(
          /caller finalization is pending/,
        )
        expect(await readFile(join(scratch, 'output'), 'utf8')).toBe('only-copy')
        expect(t.release).not.toHaveBeenCalled()
        copy.resolve({ written: 0, skipped: [] })
      }
      await expect(t.sessions.stop(run.sessionId)).resolves.toEqual({ ok: true })
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(t.sessions.has(run.sessionId)).toBe(false)
      expect(t.copyBack).toHaveBeenCalledTimes(phase === 'held final copy' ? 1 : 0)
      expect(t.release).toHaveBeenCalledTimes(phase === 'held final copy' ? 1 : 0)
      await t.fenced.leave()
      await expect(access(t.scratchRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      copy.resolve({ written: 0, skipped: [] })
      await t.terminals.closeAll().catch(() => {})
      if (pid !== undefined) {
        await reaped.promise
        const evidence = await evidenceRead!
        const ids = new Set([pid])
        for (const [, found] of evidence.matchAll(/^(?:ROOT|REAPER|ANCHOR) (\d+)$/gm))
          ids.add(Number(found))
        for (const id of ids) {
          for (const p of [id, -id])
            expect(() => process.kill(p, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
        }
      }
      // Retain the fixture unless caller proof and independent probes agree.
      expect(await readdir(leases)).toEqual([])
      await rm(root, { recursive: true, force: true })
      await rm(helper.directory, { recursive: true, force: true })
    }
  },
)

it.skipIf(process.platform === 'win32').each(['success', 'failure'] as const)(
  'joins %s of cleanup after native adapter created a real POSIX root and threw without an IPty',
  async (outcome) => {
    const helper = buildLeaseForTests()
    const root = await mkdtemp(join(tmpdir(), 'holi-pty-fenced-'))
    const leases = join(root, 'receipts')
    await mkdir(leases)
    native.helper = helper.binary
    native.directory = leases
    const cleanup = deferred<void>()
    const created = deferred<void>()
    const spawned = deferred<number>()
    const reaped = deferred<void>()
    const nativeError = Object.assign(new Error('native PTY threw after creation'), {
      cleanupPromise: cleanup.promise,
    })
    const cleanupError = new Error('native fd cleanup failed')
    native.spawn.mockImplementationOnce((file, args, opts) => {
      // Exercise the real helper/receipt without launching node-pty or Electron.
      const child = spawn(file, args, {
        cwd: opts.cwd,
        env: opts.env,
        detached: true,
        stdio: 'ignore',
      })
      child.once('error', spawned.reject)
      child.once('spawn', () => spawned.resolve(child.pid!))
      child.once('exit', () => reaped.resolve())
      created.resolve()
      throw nativeError
    })
    const t = rig(root, {})
    const start = t.start()
    void start.catch(() => {})
    let pid: number | undefined
    try {
      await created.promise
      pid = await spawned.promise
      expect(native.spawn.mock.calls[0]?.[2].env).toEqual({ PATH: '/usr/bin:/bin', LC_ALL: 'C' })
      await reaped.promise
      const absent = (p: number) =>
        expect(() => process.kill(p, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
      absent(pid)
      absent(-pid)
      await vi.waitFor(async () => expect(await readdir(leases)).toEqual([]))
      expect(await readdir(t.scratchRoot)).toHaveLength(2)
      expect(await t.start()).toMatchObject({ ok: false, cleanupUnconfirmed: true })
      expect(t.copyBack).not.toHaveBeenCalled()
      expect(t.release).not.toHaveBeenCalled()
      if (outcome === 'success') {
        cleanup.resolve()
        await expect(start).resolves.toEqual({ ok: false, message: nativeError.message })
        await t.fenced.leave()
        await expect(access(t.scratchRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      } else {
        cleanup.reject(cleanupError)
        const failure = await start.catch((err: unknown) => err)
        expect(failure).toMatchObject({ cause: nativeError, errors: [nativeError, cleanupError] })
        await expect(t.terminals.closeAll()).rejects.toBe(failure)
        await expect(t.fenced.leave()).rejects.toMatchObject({ errors: [failure] })
        expect(await readdir(t.scratchRoot)).toHaveLength(2)
        expect(await t.start()).toMatchObject({ ok: false })
      }
      expect(native.spawn).toHaveBeenCalledOnce()
    } finally {
      cleanup.resolve()
      await start.catch(() => {})
      await t.terminals.closeAll().catch(() => {})
      if (pid !== undefined) {
        await reaped.promise
        // Verify kernel absence before deleting this test's receipt namespace.
        for (const p of [pid, -pid])
          expect(() => process.kill(p, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
      }
      // Removal by the lease means all of its tracked processes (including
      // any reaper/anchor it acquired) have kernel absence proof.
      expect(await readdir(leases)).toEqual([])
      await rm(root, { recursive: true, force: true })
      await rm(helper.directory, { recursive: true, force: true })
    }
  },
)
