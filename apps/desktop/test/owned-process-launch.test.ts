import { ChildProcess, spawn, type SpawnOptions } from 'node:child_process'
import { once } from 'node:events'
import { connect } from 'node:net'
import { Duplex, PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execProgram } from '../src/main/launch'
import {
  ownedHelperIdentity,
  ownedLaunchControl,
  spawnOwnedLaunch,
} from '../src/main/owned-process-launch'
import { createOwnedProtocol, type OwnedProcessMessage } from '../src/main/owned-process-protocol'

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}))
vi.mock('node:net', () => ({ connect: vi.fn() }))

const jobId = '11111111-1111-4111-8111-111111111111'
const hello = {
  type: 'hello' as const,
  helperPid: 41,
  parentPid: process.pid,
  birth: '123456789',
  parentBirth: '123456000',
}
const plan = { file: 'tool.exe', args: [], verbatim: false }
const rootPid = 42

function fixture(
  options: SpawnOptions = {},
  retained = false,
  pid: number | null = hello.helperPid,
  onWrite?: (frame: Buffer) => void,
  exec = false,
) {
  vi.useFakeTimers()
  const child = Object.assign(new ChildProcess(), {
    pid: pid ?? undefined,
    stdin: new PassThrough(),
  })
  const writes: Buffer[] = []
  const candidate = new Duplex({
    read() {},
    write(chunk, _encoding, done) {
      onWrite?.(Buffer.from(chunk))
      writes.push(Buffer.from(chunk))
      done()
    },
  })
  vi.mocked(spawn).mockReturnValue(child)
  vi.mocked(connect).mockReturnValue(candidate as ReturnType<typeof connect>)
  const kill = vi.spyOn(ChildProcess.prototype, 'kill').mockReturnValue(true)
  const done = vi.fn<Parameters<typeof execProgram>[3]>()
  const launched = exec
    ? (execProgram(
        plan.file,
        plan.args,
        {
          env: {},
          timeoutMs: 100,
          maxBuffer: 4096,
          encoding: 'utf8',
          retainDescendantsOnSuccess: retained,
        },
        done,
        { platform: 'win32', resolve: () => null },
      ) as ReturnType<typeof spawnOwnedLaunch>)
    : spawnOwnedLaunch(plan, options, process.pid, retained)
  const spec = JSON.parse(String(child.stdin.read()))
  const helper = createOwnedProtocol({
    launchId: spec.launchId,
    secret: Buffer.from(spec.secret, 'base64'),
    role: 'helper',
  })
  function send(message: OwnedProcessMessage) {
    candidate.emit('data', helper.encode(message))
  }
  const registration = retained
    ? ({
        mode: 'retained',
        jobId: spec.jobId as string,
        commitGuardId: spec.commitGuardId as string,
        jobHandle: '123',
        commitGuardHandle: '124',
      } as const)
    : ({
        mode: 'ordinary',
        jobId,
        jobHandle: null,
        commitGuardId: null,
        commitGuardHandle: null,
      } as const)
  const setupRecord = { type: 'setup', parentBirth: hello.parentBirth, ...registration } as const
  function authenticate() {
    candidate.emit('connect')
    send(hello)
  }
  function setup() {
    authenticate()
    send(setupRecord)
  }
  function reportEmpty(exitCode: number, reason: 'natural' | 'stopped') {
    send({ type: 'root-exit', rootPid, rootExitCode: exitCode })
    send({ type: 'empty', rootPid, rootExitCode: exitCode, exitCode, reason, outputFailed: false })
  }
  return {
    child,
    candidate,
    kill,
    done,
    launched,
    helper,
    writes,
    setup,
    authenticate,
    setupRecord,
    spec,
    send,
    reportEmpty,
    commands: () => writes.splice(0).flatMap((frame) => helper.push(frame)),
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('owned launch facade', () => {
  it('rejects the receipt before teardown without cancelling the stable-handle fallback', async () => {
    const { child, candidate, kill, launched, helper } = fixture()
    candidate.emit('connect')
    candidate.emit('data', helper.encode(hello))
    candidate.emit('data', helper.encode({ type: 'error', code: 'nativeQueryFailure' }))
    const receipt = launched.ownedCompletion!
    const first = await receipt.catch((error: Error) => error)
    expect(first).toMatchObject({
      cause: expect.objectContaining({ message: 'owned helper reported nativeQueryFailure' }),
    })
    expect(candidate.destroyed).toBe(false)
    expect(kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5000)
    expect(kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    expect(candidate.destroyed).toBe(false)
    child.emit('exit', null, 'SIGKILL')
    expect(candidate.destroyed).toBe(true)
    expect(launched.ownedCompletion).toBe(receipt)
    await expect(receipt).rejects.toBe(first)
  })

  it('never transfers a socket or authenticates a late connection after the deadline', async () => {
    const { candidate, kill, launched, helper, writes } = fixture()
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(launched.ownedCompletion).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringContaining('connection timed out') }),
    })
    candidate.emit('connect')
    candidate.emit('data', helper.encode(hello))
    expect(writes).toEqual([])
    expect(candidate.destroyed).toBe(true)
    expect(kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
  })

  it('applies the stop deadline even before the first control connection', async () => {
    const { candidate, kill, launched } = fixture()
    expect(launched.kill('SIGTERM')).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    await expect(launched.ownedCompletion).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringContaining('stop timed out') }),
    })
    expect(candidate.destroyed).toBe(true)
    expect(kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
  })

  it('cancels a pending connection retry and keeps the original child error', async () => {
    const { child, candidate, launched } = fixture()
    candidate.emit('error', new Error('pipe not created yet'))
    const first = new Error('helper spawn error')
    child.emit('error', first)
    await expect(launched.ownedCompletion).rejects.toMatchObject({ cause: first })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(connect).toHaveBeenCalledTimes(1)
    await expect(launched.ownedCompletion).rejects.toMatchObject({ cause: first })
  })
})

describe('owned spawn timeout', () => {
  it('cooperatively stops a long-running Root and still joins EMPTY, EOF, and matching exit', async () => {
    const options = { timeout: 20_000 }
    const f = fixture(options)
    const settled = vi.fn()
    void f.launched.ownedCompletion.then(settled, settled)
    expect(vi.mocked(spawn).mock.calls[0]?.[2]).not.toHaveProperty('timeout')
    options.timeout = 1 // The admitted budget is independent of later option mutations.
    await vi.advanceTimersByTimeAsync(2000)
    f.setup()
    f.send({ type: 'root-created', rootPid })
    f.commands()
    expect(f.launched.kill(0)).toBe(true)
    expect(ownedLaunchControl(f.launched)?.stopped).toBe(false)
    expect(f.kill).toHaveBeenCalledExactlyOnceWith(0) // Mocked prototype, no OS probe of a fake PID.
    f.kill.mockClear()
    await vi.advanceTimersByTimeAsync(17_999)
    expect(f.commands()).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(f.commands()).toEqual([{ type: 'stop', signal: 'SIGTERM' }])
    expect(settled).not.toHaveBeenCalled()
    expect(f.kill).not.toHaveBeenCalled()

    f.reportEmpty(1, 'stopped')
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).not.toHaveBeenCalled()
    f.candidate.emit('end')
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).not.toHaveBeenCalled()
    f.child.emit('exit', 1, null)
    await expect(f.launched.ownedCompletion).resolves.toBe('empty')
    expect(f.commands()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([0, undefined])('does not impose a runtime deadline for timeout %s', async (timeout) => {
    const f = fixture({ timeout })
    f.setup()
    f.send({ type: 'root-created', rootPid })
    f.commands()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.commands()).toEqual([])
    expect(f.kill).not.toHaveBeenCalled()
    f.reportEmpty(0, 'natural')
    f.child.emit('exit', 0, null)
    f.candidate.emit('end')
    await expect(f.launched.ownedCompletion).resolves.toBe('empty')
  })

  it.each([-1, 1.5, NaN, Infinity, '10', 1n])(
    'rejects invalid timeout %s before helper admission',
    (timeout) => {
      expect(() => spawnOwnedLaunch(plan, { timeout: timeout as number }, process.pid)).toThrow(
        expect.objectContaining({
          name: 'RangeError',
          code: 'ERR_OUT_OF_RANGE',
          message: expect.stringContaining('It must be an unsigned integer.'),
        }),
      )
      expect(spawn).not.toHaveBeenCalled()
      expect(connect).not.toHaveBeenCalled()
    },
  )

  it('queues a mapped killSignal when the budget expires before authentication', async () => {
    const f = fixture({ timeout: 1, killSignal: 9 })
    await vi.advanceTimersByTimeAsync(1)
    expect(f.commands()).toEqual([])
    f.setup()
    const commands = f.commands()
    expect(commands.map((command) => command.type)).toEqual(['auth', 'registered'])
    expect(commands.at(-1)).toMatchObject({ type: 'registered', stop: 'SIGKILL' })
    // The STOP was queued, not a signal sent to the synthetic helper process.
    expect(f.kill).not.toHaveBeenCalled()
    f.send({
      type: 'empty',
      exitCode: 1,
      rootExitCode: null,
      rootPid: null,
      reason: 'stopped',
      outputFailed: false,
    })
    f.candidate.emit('end')
    f.child.emit('exit', 1, null)
    await expect(f.launched.ownedCompletion).resolves.toBe('empty')
  })

  it('keeps a pre-registration signal zero as a probe, then sends a normal runtime STOP', async () => {
    const f = fixture()
    f.authenticate()
    expect(f.launched.kill(0)).toBe(true)
    expect(f.kill).toHaveBeenCalledExactlyOnceWith(0)
    expect(ownedLaunchControl(f.launched)?.stopped).toBe(false)
    f.send(f.setupRecord)
    const [auth, registered] = f.commands()
    expect(auth?.type).toBe('auth')
    expect(registered).toMatchObject({ type: 'registered', stop: null })
    f.send({ type: 'root-created', rootPid })
    expect(f.launched.kill('SIGINT')).toBe(true)
    expect(f.commands()).toEqual([{ type: 'stop', signal: 'SIGINT' }])
    f.reportEmpty(1, 'stopped')
    f.candidate.emit('end')
    f.child.emit('exit', 1, null)
    await expect(f.launched.ownedCompletion).resolves.toBe('empty')
  })

  it('reports the original exec timeout before SETUP without pretending the helper never started', async () => {
    const f = fixture({}, false, hello.helperPid, undefined, true)
    f.authenticate()
    await vi.advanceTimersByTimeAsync(100)
    expect(f.commands()).toEqual([expect.objectContaining({ type: 'auth' })])
    f.send(f.setupRecord)
    expect(f.commands()).toEqual([expect.objectContaining({ type: 'registered', stop: 'SIGKILL' })])
    f.send({
      type: 'empty',
      exitCode: 1,
      rootExitCode: null,
      rootPid: null,
      reason: 'stopped',
      outputFailed: false,
    })
    f.candidate.emit('end')
    f.child.emit('exit', 1, null)
    const original = f.launched.ownedCompletion
    await expect(original).resolves.toBe('empty')
    expect(f.launched.ownedCompletion).toBe(original)
    expect(f.done).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        code: 'ETIMEDOUT',
        killed: true,
        helperStarted: true,
        rootStarted: false,
        rootPid: null,
        helperLastPhase: 'authenticated-hello',
      }),
      '',
      '',
      { kind: 'settled' },
    )
    expect(f.commands()).toEqual([])
  })

  it('does not certify ownership from the helper exiting after timeout', async () => {
    const f = fixture({ timeout: 100 })
    f.setup()
    f.send({ type: 'root-created', rootPid })
    await vi.advanceTimersByTimeAsync(100)
    f.child.emit('exit', 1, null)
    f.child.emit('close', 1, null)
    f.candidate.emit('end') // A normal helper exit without EMPTY is not proof of Job zero.
    await expect(f.launched.ownedCompletion).rejects.toMatchObject({
      cause: expect.objectContaining({ message: 'owned control ended without terminal receipt' }),
    })
    expect(f.kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears a configured budget on fast completion', async () => {
    const f = fixture({ timeout: 100_000, killSignal: 'SIGKILL' })
    const kill = vi.spyOn(f.launched, 'kill')
    f.setup()
    f.send({ type: 'root-created', rootPid })
    f.reportEmpty(0, 'natural')
    f.candidate.emit('end')
    f.child.emit('exit', 0, null)
    f.child.emit('close', 0, null)
    await expect(f.launched.ownedCompletion).resolves.toBe('empty')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(100_000)
    expect(kill).not.toHaveBeenCalled()
  })

  it('clears the timeout on definitive async spawn failure', async () => {
    const f = fixture({ timeout: 100_000 }, false, null)
    const [helperFile] = vi.mocked(spawn).mock.calls[0]!
    const error = Object.assign(new Error('failed to spawn'), {
      code: 'ENOENT',
      syscall: `spawn ${helperFile}`,
    })
    f.child.emit('error', error)
    await expect(f.launched.ownedCompletion).resolves.toBe('not-started')
    await expect(ownedHelperIdentity(f.launched)).rejects.toBe(error)
    expect(vi.getTimerCount()).toBe(0)
    expect(f.kill).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    'keeps AbortError and native proof failure distinct (abort first: %s)',
    async (abortFirst) => {
      const abort = new AbortController()
      const f = fixture({ timeout: 1000, signal: abort.signal, killSignal: 'SIGINT' })
      const errors = vi.fn()
      f.launched.on('error', errors)
      f.setup()
      f.commands()
      const cancel = () => abort.abort(new Error('original cancellation'))
      if (abortFirst) cancel()
      await vi.advanceTimersByTimeAsync(1000)
      if (!abortFirst) cancel()
      expect(f.commands()).toEqual([{ type: 'stop', signal: 'SIGINT' }])
      const first = errors.mock.calls[0]?.[0]
      expect(errors).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          name: 'AbortError',
          code: 'ABORT_ERR',
          cause: abort.signal.reason,
        }),
      )
      f.send({ type: 'error', code: 'nativeQueryFailure' })
      f.child.emit('exit', 125, null)
      f.child.emit('close', 125, null)
      const failure = await f.launched.ownedCompletion.catch((error: unknown) => error)
      expect(failure).toMatchObject({
        cause: expect.objectContaining({ message: 'owned helper reported nativeQueryFailure' }),
      })
      expect((failure as { commandError: unknown }).commandError).toBe(first)
      expect(f.kill).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('stops the original retained launch after ACK and before commit', async () => {
    const f = fixture({ timeout: 1000, killSignal: 'SIGKILL' }, true)
    const control = ownedLaunchControl(f.launched)!
    f.setup()
    f.send({ type: 'root-created', rootPid })
    f.send({ type: 'root-exit', rootPid, rootExitCode: 0 })
    f.send({ type: 'ready' })
    f.commands()
    expect(control.acknowledge()).toBe(true)
    expect(control.stopped).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.commands()).toEqual([{ type: 'acknowledge' }, { type: 'stop', signal: 'SIGKILL' }])
    expect(control.stopped).toBe(true)
    expect(ownedLaunchControl(f.launched)?.lease).toBe(control.lease)
    expect(f.kill).not.toHaveBeenCalled()
  })
})

it('strips AbortSignal, sends cooperative STOP, and still accepts native EMPTY', async () => {
  const abort = new AbortController()
  const f = fixture({ signal: abort.signal })
  const errors = vi.fn()
  f.launched.on('error', errors)
  expect(vi.mocked(spawn).mock.calls[0]?.[2]).not.toHaveProperty('signal')
  f.setup()
  expect(await ownedHelperIdentity(f.launched)).toEqual({
    pid: 41,
    birth: hello.birth,
    launchId: f.spec.launchId,
  })
  abort.abort(new Error('cancelled'))
  expect(errors).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ name: 'AbortError', code: 'ABORT_ERR', cause: abort.signal.reason }),
  )
  expect(f.writes.flatMap((frame) => f.helper.push(frame))).toContainEqual({
    type: 'stop',
    signal: 'SIGTERM',
  })
  f.candidate.emit(
    'data',
    f.helper.encode({
      type: 'empty',
      exitCode: 1,
      rootExitCode: null,
      rootPid: null,
      reason: 'stopped',
      outputFailed: false,
    }),
  )
  f.candidate.emit('end')
  f.child.emit('exit', 1, null)
  f.child.emit('close', 1, null)
  await expect(f.launched.ownedCompletion).resolves.toBe('empty')
  expect(f.kill).not.toHaveBeenCalled()
})

function observeCleanup() {
  const child = Object.assign(new ChildProcess(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
  })
  vi.mocked(spawn).mockReturnValueOnce(child)
  return () => JSON.parse(String(child.stdin.read()))
}

describe('retained EMPTY resource join', () => {
  it.each([false, true])('joins actual broker close in exec (lost receipt: %s)', async (lost) => {
    const f = fixture({}, true, hello.helperPid, undefined, true)
    const broker = Object.assign(new ChildProcess(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
    })
    vi.mocked(spawn).mockReturnValueOnce(broker)
    const control = ownedLaunchControl(f.launched)!
    f.setup()
    f.send({ type: 'root-created', rootPid })
    f.reportEmpty(37, 'natural')
    f.candidate.emit('end')
    expect(control.resourceCleanup).toBeUndefined()
    expect(spawn).toHaveBeenCalledTimes(1)
    f.child.emit('exit', 37, null)
    f.child.emit('close', 37, null)
    await expect(f.launched.ownedCompletion).resolves.toBe('empty')
    const cleanup = control.resourceCleanup!
    expect(cleanup).toBeInstanceOf(Promise)
    expect(control.lease.revoke()).toBe(cleanup)
    const settled = vi.fn()
    void cleanup.then(settled, settled)
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(vi.mocked(spawn).mock.calls[1]?.[2]).toMatchObject({ detached: true })
    const spec = JSON.parse(String(broker.stdin.read()))
    expect(spec).toMatchObject({ action: 'revoke', jobHandle: '123', commitGuardHandle: '124' })
    const wire = createOwnedProtocol({
      launchId: spec.launchId,
      secret: Buffer.from(spec.secret, 'base64'),
      role: 'helper',
    })
    const binding = { jobId: f.spec.jobId, commitGuardId: f.spec.commitGuardId }
    broker.stdout.write(wire.encode({ type: 'brokerReady', ...binding }))
    expect(wire.push(broker.stdin.read())).toEqual([
      { type: 'grant', action: 'revoke', ...binding },
    ])
    const cause = new Error('broker lost the close receipt')
    if (lost)
      broker.emit('error', cause) // After grant; EOF must not force-kill the broker.
    else {
      broker.stdout.write(wire.encode({ type: 'drained', ...binding }))
      const eof = once(broker.stdout, 'end')
      broker.stdout.end()
      await eof
    }
    broker.emit('exit', lost ? 125 : 0, null)
    await vi.advanceTimersByTimeAsync(100)
    expect(f.done).not.toHaveBeenCalled()
    expect(settled).not.toHaveBeenCalled()
    expect(f.kill).not.toHaveBeenCalled()
    expect(control.resourceCleanup).toBe(cleanup)
    broker.emit('close', lost ? 125 : 0, null)
    if (lost) {
      await expect(cleanup).rejects.toBe(cause)
      await expect(control.lease.revoke()).rejects.toBe(cause)
    } else await cleanup
    expect(control.lease.revoke()).toBe(cleanup)
    expect(f.done).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: 37, signal: null }),
      '',
      '',
      lost
        ? { kind: 'unconfirmed', ownership: 'empty', cause, lease: control.lease }
        : { kind: 'settled' },
    )
    await expect(f.launched.ownedCompletion).resolves.toBe('empty')
    expect(spawn).toHaveBeenCalledTimes(2)
  })
})

describe('retained launch registration recovery', () => {
  it.each(['before-first-dup', 'after-first-dup', 'after-both-dups'])(
    'starts the same pending cleanup on control failure %s',
    async () => {
      // None of these kernel states has a SETUP receipt. The broker, not Node,
      // distinguishes 0, 1 and 2 copies by comparing the actual native objects.
      const f = fixture({}, true)
      const brokerSpec = observeCleanup()
      f.authenticate()
      expect(f.commands()).toMatchObject([{ type: 'auth', mode: 'retained' }])
      const first = new Error('registration pipe failed')
      f.candidate.emit('error', first)
      const failure = await f.launched.ownedCompletion.catch((error: unknown) => error)
      const { lease, diagnostics } = ownedLaunchControl(f.launched)!
      expect(failure).toMatchObject({ cause: first, lease })
      expect(f.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
      expect(f.candidate.destroyed).toBe(true)
      f.child.emit('close', 125, null) // Stdio close does not certify producer death.
      expect(spawn).toHaveBeenCalledTimes(1)
      f.child.emit('exit', 125, null)
      await vi.advanceTimersByTimeAsync(0)
      expect(spawn).toHaveBeenCalledTimes(2) // Automatic, before any caller revoke.
      const spec = brokerSpec()
      expect(spec).toMatchObject({
        action: 'recover',
        jobId: f.spec.jobId,
        commitGuardId: f.spec.commitGuardId,
        parentBirth: hello.parentBirth,
      })
      expect(spec).not.toHaveProperty('jobHandle')
      expect(spec).not.toHaveProperty('commitGuardHandle')
      expect(diagnostics().rootStarted).toBe(false)
      expect(lease.revoke()).toBe(lease.revoke())
      expect(spawn).toHaveBeenCalledTimes(2)
    },
  )

  it('keeps the adopted slots when REGISTERED fails to write', async () => {
    const first = new Error('lost REGISTERED')
    let writes = 0
    const f = fixture({}, true, hello.helperPid, () => {
      if (++writes === 2) throw first
    })
    const brokerSpec = observeCleanup()
    f.setup()
    const { lease } = ownedLaunchControl(f.launched)!
    await expect(f.launched.ownedCompletion).rejects.toMatchObject({ cause: first, lease })
    expect(spawn).toHaveBeenCalledTimes(1)
    f.child.emit('exit', 125, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(brokerSpec()).toMatchObject({
      action: 'revoke',
      jobHandle: '123',
      commitGuardHandle: '124',
    })
    expect(lease.revoke()).toBe(lease.revoke())
  })

  it('uses a held epoch even when the AUTH write itself fails', async () => {
    const first = new Error('AUTH may have reached the helper')
    const f = fixture({}, true, hello.helperPid, () => {
      throw first
    })
    const brokerSpec = observeCleanup()
    f.authenticate()
    await expect(f.launched.ownedCompletion).rejects.toMatchObject({ cause: first })
    f.child.emit('exit', 125, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(brokerSpec()).toMatchObject({ action: 'recover', parentBirth: hello.parentBirth })
  })

  it.each(['jobId', 'commitGuardId'] as const)('rejects a different prepared %s', async (field) => {
    const f = fixture({}, true)
    const brokerSpec = observeCleanup()
    expect(f.spec.jobId).not.toBe(f.spec.commitGuardId)
    f.authenticate()
    f.send({ ...f.setupRecord, [field]: jobId })
    expect(f.commands().map(({ type }) => type)).toEqual(['auth', 'stop'])
    await expect(f.launched.ownedCompletion).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: 'owned Job registration does not match prepared identity',
      }),
    })
    f.child.emit('exit', 125, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(brokerSpec()).toMatchObject({ action: 'recover', [field]: f.spec[field] })
  })

  it('freezes late SETUP synchronously before closing control and joining the helper', async () => {
    const f = fixture({}, true)
    const brokerSpec = observeCleanup()
    f.authenticate()
    const { lease } = ownedLaunchControl(f.launched)!
    const revoke = lease.revoke()
    f.send(f.setupRecord) // No await: SETUP raced the revoke request, not its join.
    expect(f.commands().some(({ type }) => type === 'registered')).toBe(false)
    await expect(f.launched.ownedCompletion).rejects.toMatchObject({ lease })
    expect(spawn).toHaveBeenCalledTimes(1)
    f.child.emit('exit', 125, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(brokerSpec()).toMatchObject({ action: 'recover' })
    expect(lease.revoke()).toBe(revoke)
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('does not recover a retained launch that failed before AUTH', async () => {
    const f = fixture({}, true)
    f.candidate.emit('connect')
    f.send({ ...hello, helperPid: 123 })
    f.child.emit('exit', 125, null)
    const { lease } = ownedLaunchControl(f.launched)!
    await expect(f.launched.ownedCompletion).rejects.toMatchObject({ lease })
    const cleanup = lease.revoke()
    expect(ownedLaunchControl(f.launched)?.resourceCleanup).toBe(cleanup)
    await cleanup
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})
