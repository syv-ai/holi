import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execProgram } from '../src/main/launch'
import { ownedLaunchControl, spawnOwnedLaunch } from '../src/main/owned-process-launch'
import {
  OwnedProgramResourceCleanupError,
  UnconfirmedOwnedProgramError,
} from '../src/main/owned-program-lifetime'

vi.mock('../src/main/owned-process-launch', () => ({
  ownedLaunchControl: vi.fn(),
  spawnOwnedLaunch: vi.fn(),
}))

afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})

function fixture(
  retained = false,
  maxBuffer = 4096,
  adapt?: (child: ChildProcess & { ownedCompletion: unknown }) => void,
) {
  vi.useFakeTimers()
  let resolve!: (value: 'empty' | 'handoff' | 'not-started') => void
  let reject!: (cause: unknown) => void
  const proof = new Promise<'empty' | 'handoff' | 'not-started'>((res, rej) => {
    resolve = res
    reject = rej
  })
  const stop = vi.fn((_signal?: NodeJS.Signals | number) => {
    control.stopped = true
    return true
  })
  const child = Object.assign(new ChildProcess(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    ownedCompletion: proof,
    kill: stop,
  })
  let resolveCleanup!: () => void
  let rejectCleanup!: (cause: unknown) => void
  const cleanup = new Promise<void>((res, rej) => {
    resolveCleanup = res
    rejectCleanup = rej
  })
  // As in the launch adapter, the cleanup may finish before the exec join.
  void cleanup.catch(() => undefined)
  const control = {
    stopped: false,
    acknowledge: vi.fn(() => true),
    lease: { revoke: vi.fn(() => cleanup), commit: vi.fn(async () => {}) },
    resourceCleanup: retained ? cleanup : undefined,
    diagnostics: vi.fn(() => ({ helperLastPhase: 'setup-confirmed', rootStarted: false })),
  } as unknown as NonNullable<ReturnType<typeof ownedLaunchControl>> & { stopped: boolean }
  vi.mocked(ownedLaunchControl).mockReturnValue(control)
  vi.mocked(spawnOwnedLaunch).mockReturnValue(child)
  adapt?.(child)
  const done = vi.fn()
  execProgram(
    'tool.exe',
    [],
    { env: {}, timeoutMs: 100, maxBuffer, encoding: 'utf8', retainDescendantsOnSuccess: retained },
    done,
    { platform: 'win32', resolve: () => null },
  )
  const outputEnd = () => {
    child.stdout.emit('end')
    child.stderr.emit('end')
  }
  return { child, done, resolve, reject, outputEnd, control, stop, resolveCleanup, rejectCleanup }
}

describe('Windows exec output and ownership join', () => {
  it.each([true, false])(
    'keeps post-exit output and joins it with proof in either order (proof first: %s)',
    async (proofFirst) => {
      const f = fixture()
      f.child.emit('exit', 7, null)
      if (proofFirst) f.resolve('empty')
      await Promise.resolve()
      expect(f.done).not.toHaveBeenCalled()
      f.child.stdout.emit('data', 'usage: claude\n')
      f.child.stderr.emit('data', "error: unknown option '--bg'\n")
      f.child.stdout.emit('end')
      expect(f.done).not.toHaveBeenCalled()
      f.child.stderr.emit('end')
      if (!proofFirst) {
        await Promise.resolve()
        expect(f.done).not.toHaveBeenCalled()
        f.resolve('empty')
      }
      f.child.stdout.emit('close')
      f.child.stderr.emit('close')
      f.child.emit('close', 7, null)
      await Promise.resolve()
      expect(f.done).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ code: 7 }),
        'usage: claude\n',
        "error: unknown option '--bg'\n",
        { kind: 'settled' },
      )
    },
  )

  it.each([false, true])(
    'collects CreateProcess stderr without using it as ownership proof (retained: %s)',
    async (retained) => {
      const f = fixture(retained)
      const diagnostic = 'CreateProcess failed (Win32 error 2): localized system message\n'
      f.child.stderr.emit('data', diagnostic)
      f.outputEnd()
      f.child.emit('exit', 125, null)
      f.child.emit('close', 125, null)
      await Promise.resolve()
      expect(f.done).not.toHaveBeenCalled()
      f.resolve('empty')
      if (retained) {
        await Promise.resolve()
        expect(f.done).not.toHaveBeenCalled()
        f.resolveCleanup()
      }
      await vi.advanceTimersByTimeAsync(0)
      expect(f.done).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ code: 125 }),
        '',
        diagnostic,
        { kind: 'settled' },
      )
    },
  )

  it.each([
    ['plain object', {}],
    ['number', 42],
    ['thenable with invalid result', { then: (resolve: (value: unknown) => void) => resolve(42) }],
    ['missing proof', undefined],
    ['ordinary HANDOFF', { then: (resolve: (value: unknown) => void) => resolve('handoff') }],
  ])('reports %s as unconfirmed without output or status', async (_name, receipt) => {
    const f = fixture(false, 4096, (child) => (child.ownedCompletion = receipt))
    await vi.advanceTimersByTimeAsync(0)
    const error = expect.any(UnconfirmedOwnedProgramError)
    expect(f.done).toHaveBeenCalledExactlyOnceWith(error, '', '', {
      kind: 'unconfirmed',
      cause: expect.any(TypeError),
      lease: f.control.lease,
    })
    expect(f.child.stdout.destroyed).toBe(false)
    f.child.emit('error', new Error('late child error'))
    f.child.emit('exit', 1, null)
    f.outputEnd()
    f.child.emit('close', 1, null)
    await vi.advanceTimersByTimeAsync(5100)
    expect(f.done).toHaveBeenCalledOnce()
  })

  it('handles child errors before reading the receipt and keeps the getter failure and its lease', async () => {
    const first = new Error('first child failure')
    const cause = new Error('then getter failed')
    const lease = { revoke: vi.fn(async () => {}) }
    const f = fixture(true, 4096, (child) => {
      child.ownedCompletion = {
        get then(): never {
          child.emit('error', first)
          throw new UnconfirmedOwnedProgramError(cause, lease)
        },
      }
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.done).toHaveBeenCalledExactlyOnceWith(first, '', '', {
      kind: 'unconfirmed',
      cause,
      lease,
    })
    expect(f.done.mock.calls[0]![0]).toBe(first)
    expect(f.done.mock.calls[0]![3].cause).toBe(cause)
    expect(f.done.mock.calls[0]![3].lease).toBe(lease)
    expect(lease.revoke).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'requires close and output but no broker for not-started (retained: %s)',
    async (retained) => {
      const f = fixture(retained)
      const first = new Error('definitive async spawn failure')
      f.child.emit('error', first)
      f.resolve('not-started')
      f.outputEnd()
      await Promise.resolve()
      expect(f.done).not.toHaveBeenCalled()
      f.child.emit('close', -24, null)
      expect(f.done).toHaveBeenCalledExactlyOnceWith(first, '', '', { kind: 'settled' })
      expect(f.done.mock.calls[0]![0]).toBe(first)
      expect(f.control.lease.revoke).not.toHaveBeenCalled()
    },
  )

  it('never replaces the first command error or formats the proof cause into stderr', async () => {
    const f = fixture()
    const command = new Error('first stream failure')
    const cause = new Error('proof failed while stdout held open')
    f.child.stdin.emit('error', command)
    await vi.advanceTimersByTimeAsync(100)
    expect(f.done).not.toHaveBeenCalled()
    f.reject(new UnconfirmedOwnedProgramError(cause, f.control.lease))
    await Promise.resolve()
    expect(f.done).toHaveBeenCalledExactlyOnceWith(command, '', '', {
      kind: 'unconfirmed',
      cause,
      lease: f.control.lease,
    })
    expect(f.done.mock.calls[0]![0]).toBe(command)
  })

  it('reports a known proof rejection even if status and stdout are held', async () => {
    const f = fixture()
    const cause = new Error('helper died')
    const first = new UnconfirmedOwnedProgramError(cause, f.control.lease)
    f.reject(first)
    await Promise.resolve()
    expect(f.done).toHaveBeenCalledExactlyOnceWith(first, '', '', {
      kind: 'unconfirmed',
      cause,
      lease: f.control.lease,
    })
    expect(f.done.mock.calls[0]![0]).toBe(first)
  })

  it('reports lost EOF as output failure after verified zero', async () => {
    const f = fixture()
    f.child.emit('exit', 0, null)
    f.resolve('empty')
    await Promise.resolve()
    f.child.stderr.emit('end')
    f.child.stdout.emit('close')
    expect(f.done).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'Owned program stdout closed before end' }),
      '',
      '',
      { kind: 'settled' },
    )
  })

  it('keeps the callback pending while a timed-out stream destroy is in progress', async () => {
    let destroyDone!: (error: Error | null) => void
    const stdout = new PassThrough({ destroy: (_err, callback) => (destroyDone = callback) })
    const f = fixture(false, 4096, (child) => (child.stdout = stdout))
    f.child.stderr.emit('end')
    await vi.advanceTimersByTimeAsync(100)
    f.child.emit('exit', 1, null)
    f.resolve('empty')
    await vi.advanceTimersByTimeAsync(5000)
    expect(stdout.destroyed).toBe(true)
    expect(stdout.closed).toBe(false)
    expect(f.done).not.toHaveBeenCalled()
    destroyDone(null)
    await new Promise<void>((resolve) => stdout.once('close', resolve))
    expect(f.done).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: 'ETIMEDOUT' }),
      '',
      '',
      { kind: 'settled' },
    )
  })

  it('does not accept HANDOFF in retained mode without ACK', async () => {
    const f = fixture(true)
    f.resolve('handoff')
    await Promise.resolve()
    expect(f.control.acknowledge).not.toHaveBeenCalled()
    expect(f.done).toHaveBeenCalledExactlyOnceWith(
      expect.any(UnconfirmedOwnedProgramError),
      '',
      '',
      {
        kind: 'unconfirmed',
        cause: expect.any(TypeError),
        lease: f.control.lease,
      },
    )
  })

  it('carries the same uncommitted lease on retained success', async () => {
    const f = fixture(true)
    f.outputEnd()
    f.child.emit('exit', 0, null)
    f.resolve('handoff')
    await Promise.resolve()
    expect(f.done).toHaveBeenCalledExactlyOnceWith(null, '', '', {
      kind: 'settled',
      lease: f.control.lease,
    })
    expect(f.control.lease.commit).not.toHaveBeenCalled()
  })

  it('keeps timeout armed through ACK and revokes a racing HANDOFF', async () => {
    const f = fixture(true)
    f.resolveCleanup()
    f.outputEnd()
    expect(f.control.acknowledge).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(100)
    expect(f.stop).toHaveBeenCalledWith('SIGKILL')
    f.child.emit('exit', 0, null)
    f.resolve('handoff')
    await Promise.resolve()
    await Promise.resolve()
    expect(f.control.lease.revoke).toHaveBeenCalledOnce()
    expect(f.done).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: 'ETIMEDOUT' }),
      '',
      '',
      { kind: 'settled' },
    )
  })

  it('does not suppress a boxed relay failure after STOP and EMPTY', async () => {
    const f = fixture(true)
    const relay = new Error('relay failed to settle')
    f.child.kill()
    f.outputEnd()
    f.control.onOutputFailure!(relay)
    f.child.emit('exit', 1, null)
    f.resolve('empty')
    f.resolveCleanup()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.done).toHaveBeenCalledExactlyOnceWith(relay, '', '', { kind: 'settled' })
    expect(f.done.mock.calls[0]![0]).toBe(relay)
  })

  it.each(['success', 'nonzero', 'signal', 'abort', 'timeout'] as const)(
    'preserves %s command status separately from retained EMPTY cleanup failure',
    async (outcome) => {
      const f = fixture(true)
      const abortReason = new Error('original cancellation')
      const first =
        outcome === 'nonzero'
          ? Object.assign(new Error('Root failed'), { code: 37, signal: null })
          : outcome === 'signal'
            ? Object.assign(new Error('Root interrupted'), { code: null, signal: 'SIGINT' })
            : outcome === 'abort'
              ? Object.assign(new Error('The operation was aborted', { cause: abortReason }), {
                  name: 'AbortError',
                  code: 'ABORT_ERR',
                })
              : null
      if (first) f.child.emit('error', first)
      if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(100)
      f.outputEnd()
      f.child.emit('exit', outcome === 'success' ? 0 : outcome === 'nonzero' ? 37 : 1, null)
      f.resolve('empty')
      await expect(f.child.ownedCompletion).resolves.toBe('empty')
      const stops = f.stop.mock.calls.length
      await vi.advanceTimersByTimeAsync(100)
      expect(f.stop).toHaveBeenCalledTimes(stops)
      expect(f.done).not.toHaveBeenCalled()
      const cause = Object.assign(new Error('broker lost the slot-close receipt'), { code: 125 })
      f.rejectCleanup(cause)
      await vi.advanceTimersByTimeAsync(0)
      const expectedError =
        first ??
        (outcome === 'timeout'
          ? expect.objectContaining({ code: 'ETIMEDOUT', killed: true })
          : expect.any(OwnedProgramResourceCleanupError))
      expect(f.done).toHaveBeenCalledExactlyOnceWith(expectedError, '', '', {
        kind: 'unconfirmed',
        ownership: 'empty',
        cause,
        lease: f.control.lease,
      })
      const [error, , , metadata] = f.done.mock.calls[0]!
      if (first) expect(error).toBe(first)
      if (outcome === 'success') {
        expect(error.cause).toBe(cause)
        expect(error.lease).toBe(f.control.lease)
      }
      expect(metadata.cause).toBe(cause)
      expect(metadata.lease).toBe(f.control.lease)
      expect(f.control.lease.revoke).not.toHaveBeenCalled()
      await expect(f.child.ownedCompletion).resolves.toBe('empty')
    },
  )

  it('reports proof failure while retained cleanup and stderr are still held', async () => {
    const f = fixture(true)
    const cause = new Error('native query failed')
    const first = new UnconfirmedOwnedProgramError(cause, f.control.lease)
    f.child.stdout.emit('end')
    f.reject(first)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.done).toHaveBeenCalledExactlyOnceWith(first, '', '', {
      kind: 'unconfirmed',
      cause,
      lease: f.control.lease,
    })
    expect(f.child.stderr.destroyed).toBe(false)
    const cleanupCause = new Error('later cleanup failure')
    f.rejectCleanup(cleanupCause)
    await expect(f.control.lease.revoke()).rejects.toBe(cleanupCause)
    expect(f.done.mock.calls[0]![0]).toBe(first)
    expect(f.done).toHaveBeenCalledOnce()
  })

  it.each(['exit', 'timeout', 'stream-error'] as const)(
    'still stops on late maxBuffer after %s without replacing the first error',
    async (firstFailure) => {
      const f = fixture(false, 6)
      const first = new Error('first stream error')
      if (firstFailure === 'exit') f.child.emit('exit', 7, null)
      if (firstFailure === 'timeout') await vi.advanceTimersByTimeAsync(100)
      if (firstFailure === 'stream-error') f.child.stdin.emit('error', first)
      const stops = f.stop.mock.calls.length
      f.child.stdout.emit('data', '12')
      f.child.stderr.emit('data', '3456')
      f.child.stderr.emit('data', 'overflow')
      expect(f.stop).toHaveBeenCalledTimes(stops + 1)
      expect(f.stop).toHaveBeenLastCalledWith('SIGKILL')
      f.child.stdout.emit('data', 'discarded')
      f.child.stderr.emit('error', new Error('later stream error'))
      f.child.emit('exit', 1, null)
      f.outputEnd()
      expect(f.done).not.toHaveBeenCalled()
      f.resolve('empty')
      await Promise.resolve()
      const expected =
        firstFailure === 'stream-error'
          ? first
          : expect.objectContaining({
              code: firstFailure === 'exit' ? 7 : 'ETIMEDOUT',
            })
      expect(f.done).toHaveBeenCalledExactlyOnceWith(expected, '12', '3456', { kind: 'settled' })
      if (firstFailure === 'stream-error') expect(f.done.mock.calls[0]![0]).toBe(first)
    },
  )

  it('does not let timeout replace maxBuffer while teardown is pending', async () => {
    const f = fixture(false, 1)
    f.child.stdout.emit('data', 'overflow')
    await vi.advanceTimersByTimeAsync(100)
    expect(f.done).not.toHaveBeenCalled()
    f.child.emit('exit', 1, null)
    f.outputEnd()
    f.resolve('empty')
    await Promise.resolve()
    expect(f.done).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
      '',
      '',
      { kind: 'settled' },
    )
  })

  it('emits explicit plan-failure metadata without an adapter call', async () => {
    vi.useRealTimers()
    const done = vi.fn()
    execProgram(
      'nul\0.bin',
      [],
      { env: {}, maxBuffer: 4096, timeoutMs: 100, encoding: 'utf8' },
      done,
      { platform: 'win32' },
    )
    await new Promise<void>((resolve) => process.nextTick(resolve))
    expect(spawnOwnedLaunch).not.toHaveBeenCalled()
    expect(done).toHaveBeenCalledExactlyOnceWith(expect.any(Error), '', '', { kind: 'settled' })
  })
})
