import { ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { connect } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnOwnedProgram } from '../src/main/owned-process'
import { spawnOwnedLaunch } from '../src/main/owned-process-launch'
import {
  joinOwnedProgram,
  UnconfirmedOwnedProgramError,
  type OwnedCompletion,
} from '../src/main/owned-program-lifetime'

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}))
vi.mock('node:net', () => ({ connect: vi.fn() }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function controlledChild(ownedCompletion?: Promise<OwnedCompletion>) {
  return Object.assign(new ChildProcess(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
    ownedCompletion,
  })
}

async function expectPending(observed: ReturnType<typeof vi.fn>) {
  await Promise.resolve()
  await Promise.resolve()
  expect(observed).not.toHaveBeenCalled()
}

const exe = { file: 'tool.exe', args: [], verbatim: false }

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

describe('joinOwnedProgram', () => {
  it('waits for authenticated ownership after Windows exit and output end, including nonzero exit', async () => {
    const receipt = deferred<OwnedCompletion>()
    const child = controlledChild(receipt.promise)
    const joined = joinOwnedProgram(child, 'win32')
    const settled = vi.fn()
    void joined.then(settled, settled)
    child.emit('exit', 37, null)
    child.stdout.emit('end')
    child.stderr.emit('end')
    child.emit('close', 37, null)
    await expectPending(settled)
    receipt.resolve('empty')
    await expect(joined).resolves.toEqual({
      code: 37,
      signal: null,
      error: null,
      ownership: 'empty',
    })
  })

  it('does not let proof or child close stand in for the two Windows output streams', async () => {
    const child = controlledChild(Promise.resolve('empty'))
    const joined = joinOwnedProgram(child, 'win32')
    const settled = vi.fn()
    void joined.then(settled, settled)
    await expectPending(settled)
    child.emit('close', null, 'SIGTERM')
    child.stdout.emit('end')
    await expectPending(settled)
    child.stderr.emit('end')
    await expect(joined).resolves.toEqual({
      code: null,
      signal: 'SIGTERM',
      error: null,
      ownership: 'empty',
    })
  })

  it('also waits for child exit when ownership and output settle first', async () => {
    const child = controlledChild(Promise.resolve('empty'))
    const joined = joinOwnedProgram(child, 'win32')
    const settled = vi.fn()
    void joined.then(settled, settled)
    child.stdout.emit('end')
    child.stderr.emit('end')
    await expectPending(settled)
    child.emit('exit', 0, null)
    await expect(joined).resolves.toMatchObject({ code: 0, ownership: 'empty' })
  })

  it('joins explicit no-spawn through the planning error, with no spawn or control connection', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
    let child: ReturnType<typeof spawnOwnedProgram>
    try {
      child = spawnOwnedProgram('unstartable\0.exe', [], { stdio: 'pipe' })
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }
    const events: string[] = []
    child.on('error', () => events.push('error'))
    child.on('close', () => events.push('close'))
    const result = await joinOwnedProgram(child, 'win32')
    expect(result).toEqual({
      code: null,
      signal: null,
      error: expect.objectContaining({ message: expect.stringContaining('NUL') }),
      ownership: 'not-started',
    })
    expect(child.ownedCompletion).toBeDefined()
    expect(events).toEqual(['error', 'close'])
    expect(spawn).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })

  it('uses a definitive Node OS spawn error even when there are no pipes', async () => {
    const child = Object.assign(new ChildProcess(), { stdin: null, stdout: null, stderr: null })
    vi.mocked(spawn).mockReturnValue(child)
    const managed = spawnOwnedLaunch(exe, {}, process.pid)
    const joined = joinOwnedProgram(managed, 'win32')
    const first = Object.assign(new Error('too many open files'), {
      code: 'EMFILE',
      syscall: `spawn ${vi.mocked(spawn).mock.calls[0]![0]}`,
    })
    child.emit('error', first)
    child.emit('close', -24, null)
    const result = await joined
    expect(result).toMatchObject({ code: null, signal: null, ownership: 'not-started' })
    expect(result.error).toBe(first)
    expect(connect).not.toHaveBeenCalled()
  })

  it('does not infer no-spawn from an unclassified child error and missing pid', async () => {
    const child = controlledChild()
    vi.mocked(spawn).mockReturnValue(child)
    const managed = spawnOwnedLaunch(exe, {}, process.pid)
    const joined = joinOwnedProgram(managed, 'win32')
    const cause = new Error('spawn state unknown')
    expect(child.pid).toBeUndefined()
    child.emit('error', cause)
    await expect(joined).rejects.toBeInstanceOf(UnconfirmedOwnedProgramError)
    const failure = await joined.catch((error: UnconfirmedOwnedProgramError) => error)
    expect(failure).toMatchObject({ cause, commandError: cause })
    expect(connect).not.toHaveBeenCalled()
  })

  it.each([undefined, 43210])(
    'rejects missing Windows proof with pid %s without OS operations',
    async (pid) => {
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('controlled children must never signal an OS pid')
      })
      const child = Object.assign(controlledChild(), { pid })
      const joined = joinOwnedProgram(child, 'win32')
      await expect(joined).rejects.toBeInstanceOf(UnconfirmedOwnedProgramError)
      expect(child.kill).not.toHaveBeenCalled()
      expect(kill).not.toHaveBeenCalled()
      expect(spawn).not.toHaveBeenCalled()
      expect(connect).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['plain object', {}],
    ['number', 42],
    ['bare proof literal', 'empty'],
    [
      'thenable with an invalid result',
      { then: (resolve: (value: unknown) => void) => resolve(42) },
    ],
  ])('promptly caches a typed rejection for a %s receipt', async (_name, receipt) => {
    const child = controlledChild(receipt as Promise<OwnedCompletion>)
    const joined = joinOwnedProgram(child, 'win32')
    const settled = vi.fn()
    void joined.then(settled, settled)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).toHaveBeenCalledExactlyOnceWith(expect.any(UnconfirmedOwnedProgramError))
    expect(child.stdout.destroyed).toBe(false)
    Object.assign(child, { ownedCompletion: Promise.resolve('not-started') })
    expect(joinOwnedProgram(child, 'win32')).toBe(joined)
    await expect(joinOwnedProgram(child, 'win32')).rejects.toBe(settled.mock.calls[0]![0])
  })

  it('handles child errors before a throwing receipt getter, preserving its cause and lease', async () => {
    const child = controlledChild()
    const commandError = new Error('first child error from adapter')
    const cause = new Error('then getter failed')
    const lease = { revoke: vi.fn(async () => {}) }
    const receipt = {
      get then(): never {
        child.emit('error', commandError)
        throw new UnconfirmedOwnedProgramError(cause, lease)
      },
    }
    Object.assign(child, { ownedCompletion: receipt })
    const joined = joinOwnedProgram(child, 'win32')
    const settled = vi.fn()
    void joined.then(settled, settled)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).toHaveBeenCalledExactlyOnceWith(expect.any(UnconfirmedOwnedProgramError))
    const failure = settled.mock.calls[0]![0] as UnconfirmedOwnedProgramError
    expect(failure.cause).toBe(cause)
    expect(failure.lease).toBe(lease)
    expect(failure.commandError).toBe(commandError)
    child.emit('error', new Error('late child error'))
    child.stdout.emit('close')
    child.emit('exit', 1, null)
    expect(joinOwnedProgram(child, 'win32')).toBe(joined)
    await expect(joined).rejects.toBe(failure)
  })

  it('does not accept retained handoff as an ordinary Windows receipt', async () => {
    const receipt = Promise.resolve('handoff') as unknown as Promise<OwnedCompletion>
    const joined = joinOwnedProgram(controlledChild(receipt), 'win32')
    await expect(joined).rejects.toMatchObject({
      name: 'UnconfirmedOwnedProgramError',
      cause: expect.objectContaining({ message: expect.stringContaining('Invalid receipt') }),
    })
  })

  it('rejects proof immediately with original cause and launch lease while output is held', async () => {
    const receipt = deferred<OwnedCompletion>()
    const child = controlledChild(receipt.promise)
    const joined = joinOwnedProgram(child, 'win32')
    const commandError = new Error('first command failure')
    const cause = new Error('native proof failed')
    const lease = { revoke: vi.fn(async () => {}) }
    child.emit('error', commandError)
    receipt.reject(new UnconfirmedOwnedProgramError(cause, lease))
    const failure = await joined.catch((error: UnconfirmedOwnedProgramError) => error)
    expect(failure).toBeInstanceOf(UnconfirmedOwnedProgramError)
    expect(failure).toMatchObject({ cause, lease, commandError })
    expect((failure as UnconfirmedOwnedProgramError).cause).toBe(cause)
    expect((failure as UnconfirmedOwnedProgramError).lease).toBe(lease)
    expect((failure as UnconfirmedOwnedProgramError).commandError).toBe(commandError)
    expect(child.stdout.destroyed).toBe(false)
    expect(lease.revoke).not.toHaveBeenCalled()
    child.stderr.emit('error', new Error('late output failure'))
    Object.assign(child, { ownedCompletion: Promise.resolve('empty') })
    expect(joinOwnedProgram(child, 'win32')).toBe(joined)
    await expect(joinOwnedProgram(child, 'win32')).rejects.toBe(failure)
  })

  it('does not settle on a stream error alone, and close without end is an output failure', async () => {
    const child = controlledChild(Promise.resolve('empty'))
    const joined = joinOwnedProgram(child, 'win32')
    const settled = vi.fn()
    void joined.then(settled, settled)
    const first = new Error('early write failure')
    child.stdin.emit('error', first)
    child.stdout.emit('error', new Error('read failed, but not closed'))
    child.emit('exit', 0, null)
    child.stderr.emit('end')
    await expectPending(settled)
    child.stdout.emit('close')
    expect((await joined).error).toBe(first)

    const closedEarly = controlledChild(Promise.resolve('empty'))
    const second = joinOwnedProgram(closedEarly, 'win32')
    closedEarly.stdout.emit('close')
    closedEarly.stderr.emit('end')
    closedEarly.emit('exit', 0, null)
    const result = await second
    expect(result.ownership).toBe('empty')
    expect(result.error?.message).toContain('stdout closed before end')
  })

  it.each(['exit', 'proof', 'stop'] as const)(
    'bounds output only after Windows %s without fabricating ownership or child exit',
    async (trigger) => {
      vi.useFakeTimers()
      const receipt = deferred<OwnedCompletion>()
      const child = controlledChild(receipt.promise)
      const stop = child.kill
      const joined = joinOwnedProgram(child, 'win32')
      const settled = vi.fn()
      void joined.then(settled, settled)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(child.stdout.destroyed).toBe(false)
      expect(child.stderr.destroyed).toBe(false)
      if (trigger === 'exit') child.emit('exit', 0, null)
      if (trigger === 'proof') receipt.resolve('empty')
      if (trigger === 'stop') {
        expect(child.kill()).toBe(true)
        expect(stop).toHaveBeenCalledTimes(1)
      }
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(5000)
      expect(child.stdout.destroyed).toBe(true)
      expect(child.stderr.destroyed).toBe(true)
      await expectPending(settled)
      if (trigger !== 'proof') receipt.resolve('empty')
      if (trigger !== 'exit') child.emit('exit', 0, null)
      const result = await joined
      expect(result.ownership).toBe('empty')
      expect(result.error?.message).toContain('stdout did not settle')
    },
  )

  it('waits for actual Windows stream destruction after the output deadline', async () => {
    vi.useFakeTimers()
    let destroyed!: (error: Error | null) => void
    const stdout = new PassThrough({ destroy: (_err, callback) => (destroyed = callback) })
    const child = Object.assign(controlledChild(Promise.resolve('empty')), { stdout })
    const joined = joinOwnedProgram(child, 'win32')
    const settled = vi.fn()
    void joined.then(settled, settled)
    child.emit('exit', 0, null)
    child.stderr.emit('end')
    await vi.advanceTimersByTimeAsync(5000)
    expect(stdout.destroyed).toBe(true)
    expect(stdout.closed).toBe(false)
    stdout.emit('end')
    await expectPending(settled)
    const closed = once(stdout, 'close')
    destroyed(null)
    await closed
    expect((await joined).error?.message).toContain('stdout did not settle')
  })

  it('treats Windows signal zero as a probe, not a stop or an output deadline', async () => {
    vi.useFakeTimers()
    const nativeKill = vi.spyOn(ChildProcess.prototype, 'kill').mockReturnValue(true)
    const receipt = deferred<OwnedCompletion>()
    const child = controlledChild(receipt.promise)
    const stop = child.kill
    const joined = joinOwnedProgram(child, 'win32')
    expect(child.kill(0)).toBe(true)
    expect(nativeKill).toHaveBeenCalledExactlyOnceWith(0)
    expect(stop).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(6000)
    expect(child.stdout.destroyed).toBe(false)
    child.emit('exit', 0, null)
    child.stdout.emit('end')
    child.stderr.emit('end')
    receipt.resolve('empty')
    expect((await joined).error).toBeNull()
  })

  it('keeps POSIX close semantics without wrapping kill or timing out output', async () => {
    vi.useFakeTimers()
    const child = controlledChild()
    const kill = child.kill
    const joined = joinOwnedProgram(child, 'linux')
    expect(child.kill).toBe(kill)
    child.kill(0)
    child.kill('SIGTERM')
    expect(kill.mock.calls).toEqual([[0], ['SIGTERM']])
    const settled = vi.fn()
    void joined.then(settled, settled)
    child.emit('exit', 0, null)
    await vi.advanceTimersByTimeAsync(6000)
    await expectPending(settled)
    child.emit('close', 0, null)
    await expect(joined).resolves.toEqual({
      code: 0,
      signal: null,
      error: null,
      ownership: undefined,
    })
    expect(child.stdout.destroyed).toBe(false)
  })

  it('subscribes once and takes the first receipt and first error for every join', async () => {
    const receipt = deferred<OwnedCompletion>()
    const observe = vi.spyOn(receipt.promise, 'then')
    const child = controlledChild(receipt.promise)
    const joined = joinOwnedProgram(child, 'win32')
    const errorCount = child.stdout.listenerCount('error')
    Object.assign(child, { ownedCompletion: new Promise<OwnedCompletion>(() => {}) })
    for (let i = 0; i < 20; i++) expect(joinOwnedProgram(child, 'win32')).toBe(joined)
    expect(observe).toHaveBeenCalledTimes(1)
    expect(child.stdout.listenerCount('error')).toBe(errorCount)
    const first = new Error('first failure')
    child.stderr.emit('error', first)
    child.emit('error', new Error('second failure'))
    child.stdout.emit('end')
    child.stderr.emit('end')
    child.emit('exit', 0, null)
    receipt.resolve('empty')
    const result = await joined
    child.stdout.emit('error', new Error('late failure'))
    expect(result.error).toBe(first)
    expect(await joinOwnedProgram(child, 'win32')).toBe(result)
  })
})
