import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLeaseForTests } from '../../../../test/fixtures/posix-native-build'
import { createFencedSessions } from '../main/host/fenced'
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
  release = vi.fn(async (_state: string) => {}),
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
      bin: '/bin/sh',
      args: ['-c', 'exit 91'],
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
    idleMs: 100,
  })
  const copyBack = vi.fn(async (..._args: unknown[]) => ({ written: 0, skipped: [] }))
  const scratchRoot = join(root, 'fenced')
  const fenced = createFencedSessions({
    vault,
    scratchRoot,
    own: sessions,
    copyBack,
    log: () => {},
  })
  const start = () =>
    fenced.start({ provider, name: 'fenced', prompt: 'go', scope: { read: [], write: [] } })
  return { terminals, sessions, fenced, start, scratchRoot, copyBack, release, bracket, emit }
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
