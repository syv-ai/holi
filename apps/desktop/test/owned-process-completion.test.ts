import { EventEmitter, once } from 'node:events'
import { Duplex } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOwnedProtocol, type OwnedProcessMessage } from '../src/main/owned-process-protocol'
import { manageOwnedCompletion } from '../src/main/owned-process-completion'

const launchId = 'test-launch'
const secret = Buffer.alloc(32, 7)
const jobId = '11111111-1111-4111-8111-111111111111'
const hello = {
  type: 'hello' as const,
  helperPid: 41,
  parentPid: 12,
  birth: '123456',
  parentBirth: '100000',
}
const auth = { type: 'auth' as const, helperPid: 41, parentPid: 12, mode: 'ordinary' as const }
const setup = {
  type: 'setup' as const,
  mode: 'ordinary' as const,
  parentBirth: '100000',
  jobId,
  jobHandle: null,
  commitGuardId: null,
  commitGuardHandle: null,
}

const retainedSetup = {
  ...setup,
  mode: 'retained' as const,
  jobHandle: 'a4',
  commitGuardId: '22222222-2222-4222-8222-222222222222',
  commitGuardHandle: 'b4',
}
const created = { type: 'root-created' as const, rootPid: 70 }
const exited = { type: 'root-exit' as const, rootPid: 70, rootExitCode: 0 }
const handoff = {
  type: 'handoff' as const,
  exitCode: 0 as const,
  rootExitCode: 0 as const,
  rootPid: 70,
}

type Endpoint = Duplex & { peer?: Endpoint }
const fixtures = new Set<() => void>()

afterEach(() => {
  try {
    for (const cleanup of fixtures) cleanup()
  } finally {
    fixtures.clear()
    if (vi.isFakeTimers()) {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  }
})

function duplexPair(): [Endpoint, Endpoint] {
  const make = () =>
    new Duplex({
      read() {},
      write(this: Endpoint, chunk, _encoding, done) {
        this.peer!.push(Buffer.from(chunk))
        done()
      },
      final(this: Endpoint, done) {
        this.peer!.push(null)
        done()
      },
    }) as Endpoint
  const left = make()
  const right = make()
  left.peer = right
  right.peer = left
  return [left, right]
}

function fixture(
  setupTimeoutMs = 500,
  stopTimeoutMs = 500,
  mode: 'ordinary' | 'retained' = 'ordinary',
  beforeAuth?: Parameters<typeof manageOwnedCompletion>[0]['beforeAuth'],
  hooks?: Pick<Parameters<typeof manageOwnedCompletion>[0], 'pauseAuthForTest' | 'onSetup'>,
) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number
    kill: (signal?: NodeJS.Signals | number) => boolean
  }
  child.pid = 41
  child.kill = vi.fn(() => true)
  const killHelper = vi.fn(() => true)
  const [control, helperControl] = duplexPair()
  const controlClosed = new Promise<void>((resolve) => control.once('close', resolve))
  const helper = createOwnedProtocol({ launchId, secret, role: 'helper' })
  const manager = manageOwnedCompletion({
    launchId,
    secret,
    parentPid: 12,
    helperPid: 41,
    child: child as never,
    killHelper,
    control,
    setupTimeoutMs,
    stopTimeoutMs,
    terminalTimeoutMs: stopTimeoutMs,
    partialTimeoutMs: stopTimeoutMs,
    beforeAuth,
    ...hooks,
    mode,
  })
  const messages: OwnedProcessMessage[] = []
  const waiters: ((message: OwnedProcessMessage) => void)[] = []
  helperControl.on('data', (chunk: Buffer) => {
    for (const message of helper.push(chunk)) {
      const waiter = waiters.shift()
      if (waiter) waiter(message)
      else messages.push(message)
    }
  })
  const send = (message: Parameters<typeof helper.encode>[0]) =>
    new Promise<void>((resolve, reject) => {
      helperControl.write(helper.encode(message), (error) => (error ? reject(error) : resolve()))
    })
  const receive = () => {
    const message = messages.shift()
    if (message) return Promise.resolve(message)
    return new Promise<OwnedProcessMessage>((resolve) => waiters.push(resolve))
  }
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    child.emit('exit', null, 'SIGKILL')
    helperControl.destroy()
    fixtures.delete(close)
  }
  fixtures.add(close)
  return {
    child,
    killHelper,
    control,
    controlClosed,
    helper,
    helperControl,
    manager,
    send,
    receive,
    close,
    async history(code = 0) {
      await send(created)
      await send({ ...exited, rootExitCode: code })
    },
    async setup(stop: Extract<OwnedProcessMessage, { type: 'registered' }>['stop'] = null) {
      await send(hello)
      expect(await receive()).toEqual({ ...auth, mode })
      await this.register(stop)
    },
    async register(stop: Extract<OwnedProcessMessage, { type: 'registered' }>['stop']) {
      const record = mode === 'retained' ? retainedSetup : setup
      await send(record)
      const { mode: _mode, parentBirth: _birth, ...binding } = record
      expect(await receive()).toEqual({ ...binding, type: 'registered', stop })
    },
  }
}

async function expectReleased(f: ReturnType<typeof fixture>) {
  await f.controlClosed
  expect(f.control.destroyed).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  for (const event of ['exit', 'close']) expect(f.child.listenerCount(event)).toBe(0)
  for (const event of ['data', 'end', 'close', 'error'])
    expect(f.control.listenerCount(event)).toBe(0)
}

const stoppedBeforeRoot = {
  type: 'empty' as const,
  exitCode: 1,
  rootExitCode: null,
  rootPid: null,
  reason: 'stopped' as const,
  outputFailed: false,
}

const empty = {
  type: 'empty' as const,
  exitCode: 0,
  rootExitCode: 0,
  rootPid: 70,
  reason: 'natural' as const,
  outputFailed: false,
}

describe('owned process completion controller', () => {
  it('authenticates HELLO and requires ready, ACK, terminal, transcript end and helper exit', async () => {
    const f = fixture(500, 500, 'retained')
    await f.setup()
    await f.history()
    await f.send({ type: 'ready' })
    expect(f.manager.acknowledgeSuccess()).toBe(true)
    expect(f.manager.acknowledgeSuccess()).toBe(false)
    expect(await f.receive()).toEqual({ type: 'acknowledge' })
    await f.send(handoff)
    f.helperControl.end()
    f.child.emit('exit', 0, null)
    await expect(f.manager.completion).resolves.toBe('handoff')
    f.close()
  })

  it('accepts fragmented HELLO and joins transcript EOF with verified helper exit', async () => {
    const f = fixture()
    const frame = f.helper.encode(hello)
    await new Promise<void>((resolve, reject) => {
      f.helperControl.write(frame.subarray(0, 7), (error) => (error ? reject(error) : resolve()))
    })
    await new Promise<void>((resolve, reject) => {
      f.helperControl.write(frame.subarray(7), (error) => (error ? reject(error) : resolve()))
    })
    expect(await f.receive()).toEqual(auth)
    await f.send(setup)
    expect(await f.receive()).toEqual({
      type: 'registered',
      jobId,
      jobHandle: null,
      commitGuardId: null,
      commitGuardHandle: null,
      stop: null,
    })
    await f.history()
    await f.send(empty)
    f.helperControl.end()
    let settled = false
    void f.manager.completion.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    f.child.emit('exit', 0, null)
    await expect(f.manager.completion).resolves.toBe('empty')
    f.close()
  })

  it('keeps an authenticated ordinary program pending past setup until EMPTY, EOF and exit', async () => {
    vi.useFakeTimers()
    const f = fixture(15_000, 5000)
    const observe = vi.fn()
    const receipt = f.manager.completion
    void receipt.then(observe, observe)
    await f.setup()
    const timersAfterAuth = vi.getTimerCount()

    await vi.advanceTimersByTimeAsync(21_000)
    expect(observe).not.toHaveBeenCalled()
    expect(f.killHelper).not.toHaveBeenCalled()
    expect(timersAfterAuth).toBe(0)
    expect(vi.getTimerCount()).toBe(0)

    await f.history()
    await f.send(empty)
    f.helperControl.end()
    f.child.emit('exit', 0, null)
    await expect(receipt).resolves.toBe('empty')
    expect(f.manager.completion).toBe(receipt)
    await expectReleased(f)
  })

  it('rejects bad MAC frames without waiting for helper close', async () => {
    const f = fixture()
    const attacker = createOwnedProtocol({ launchId, secret: Buffer.alloc(32, 8), role: 'helper' })
    await new Promise<void>((resolve, reject) => {
      f.helperControl.write(attacker.encode(hello), (error) => (error ? reject(error) : resolve()))
    })
    await expect(f.manager.completion).rejects.toThrow('Invalid owned-process frame')
    f.close()
  })

  it('rejects invalid authenticated identity immediately and keeps failure sticky', async () => {
    const f = fixture()
    await f.send({ ...hello, helperPid: 99 })
    await expect(f.manager.completion).rejects.toThrow('identity mismatch')
    f.child.emit('exit', 1, null)
    expect(f.manager.acknowledgeSuccess()).toBe(false)
    f.close()
  })

  it('rejects abnormal helper termination before a terminal record', async () => {
    const f = fixture()
    f.child.emit('exit', null, 'SIGKILL')
    await expect(f.manager.completion).rejects.toThrow('exited abnormally')
    f.close()
  })

  it('rejects an empty record with contradictory helper exit status', async () => {
    const f = fixture()
    await f.setup()
    await f.history()
    await f.send(empty)
    f.helperControl.end()
    f.child.emit('exit', 1, null)
    await expect(f.manager.completion).rejects.toThrow('contradicts')
    f.close()
  })

  it.each(['ordinary', 'retained'] as const)(
    'folds a queued stop into %s registration, with no trailing STOP',
    async (mode) => {
      let allowAuth!: () => void
      const gate = new Promise<void>((resolve) => (allowAuth = resolve))
      const pauseAuthForTest = vi.fn(() => gate)
      const f = fixture(500, 500, mode, undefined, { pauseAuthForTest })
      const writes = vi.spyOn(f.control, 'write')
      await f.send(hello)
      expect(pauseAuthForTest).toHaveBeenCalledExactlyOnceWith(hello)
      expect(f.manager.stop('SIGINT')).toBe(true)
      expect(writes).not.toHaveBeenCalled()
      allowAuth()
      expect(await f.receive()).toEqual({ ...auth, mode })
      expect(f.manager.stop('SIGKILL')).toBe(true) // First STOP owns the decision.
      expect(writes).toHaveBeenCalledTimes(1)
      await f.register('SIGINT')
      expect(f.manager.stop()).toBe(true)
      await f.send(stoppedBeforeRoot)
      f.helperControl.end()
      f.child.emit('exit', 1, null)
      await expect(f.manager.completion).resolves.toBe('empty')
      expect(writes).toHaveBeenCalledTimes(2)
      expect(f.killHelper).not.toHaveBeenCalled()
    },
  )

  it('takes the decision after synchronous SETUP adoption', async () => {
    const f = fixture(500, 500, 'retained', undefined, {
      onSetup: () => expect(f.manager.stop('SIGHUP')).toBe(true),
    })
    await f.setup('SIGHUP')
    await f.send(stoppedBeforeRoot)
    f.helperControl.end()
    f.child.emit('exit', 1, null)
    await expect(f.manager.completion).resolves.toBe('empty')
  })

  it.each([
    [created, /root created after stopped registration/],
    [exited, /contradictory owned root exit/],
    [{ ...stoppedBeforeRoot, rootPid: 70, rootExitCode: 1 }, /contradicts root history/],
    [
      { ...stoppedBeforeRoot, reason: 'launch-failed' as const, exitCode: 125 },
      /contradictory owned EMPTY/,
    ],
  ] as const)('rejects %j after a stopped registration', async (contradiction, error) => {
    const f = fixture()
    expect(f.manager.stop()).toBe(true)
    await f.setup('SIGTERM')
    await f.send(contradiction)
    await expect(f.manager.completion).rejects.toThrow(error)
  })

  it('rejects a helper ERROR without waiting for process close and preserves it', async () => {
    const f = fixture()
    await f.setup()
    await f.send({ type: 'error', code: 'nativeQueryFailure' })
    await expect(f.manager.completion).rejects.toThrow('nativeQueryFailure')
    expect(await f.receive()).toEqual({ type: 'stop', signal: 'SIGKILL' })
    f.close()
  })

  it('rejects duplicate terminal records', async () => {
    const f = fixture()
    await f.setup()
    await f.history()
    await f.send(empty)
    await f.send(empty)
    await expect(f.manager.completion).rejects.toThrow('after owned terminal')
    f.close()
  })

  it('fails closed on incomplete control transcript', async () => {
    const f = fixture()
    await f.setup()
    await new Promise<void>((resolve, reject) => {
      f.helperControl.write(Buffer.from('{broken'), (error) => (error ? reject(error) : resolve()))
    })
    f.helperControl.end()
    await expect(f.manager.completion).rejects.toBeInstanceOf(Error)
    f.close()
  })

  it('joins helper exit before buffered terminal and transcript EOF', async () => {
    const f = fixture()
    await f.setup()
    f.child.emit('exit', 0, null)
    await f.history()
    await f.send(empty)
    f.helperControl.end()
    await expect(f.manager.completion).resolves.toBe('empty')
    f.close()
  })

  it('keeps buffered control alive when helper close arrives first', async () => {
    const f = fixture()
    await f.setup()
    f.child.emit('exit', 0, null)
    f.child.emit('close', 0, null)
    await f.history()
    await f.send(empty)
    f.helperControl.end()
    await expect(f.manager.completion).resolves.toBe('empty')
    f.close()
  })

  it('rejects normal helper exit and EOF without a terminal receipt', async () => {
    const f = fixture()
    await f.setup()
    f.child.emit('exit', 0, null)
    f.helperControl.end()
    await expect(f.manager.completion).rejects.toThrow('without terminal receipt')
    f.close()
  })

  it('times out waiting for setup when the helper does not authenticate', async () => {
    vi.useFakeTimers()
    const f = fixture(50, 20)
    await vi.advanceTimersByTimeAsync(50)
    await expect(f.manager.completion).rejects.toThrow('setup timed out')
    expect(f.control.destroyed).toBe(false)
    f.child.emit('exit', 1, null)
    await expectReleased(f)
    expect(f.killHelper).not.toHaveBeenCalled()
  })

  it('times out after helper exit when control stays open without a terminal receipt', async () => {
    vi.useFakeTimers()
    const f = fixture(50, 20)
    const observe = vi.fn()
    void f.manager.completion.then(observe, observe)
    await f.setup()
    await vi.advanceTimersByTimeAsync(100)
    f.child.emit('exit', 0, null)
    f.child.emit('close', 0, null)
    await vi.advanceTimersByTimeAsync(19)
    expect(observe).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(observe).toHaveBeenCalledExactlyOnceWith(expect.any(Error))
    await expect(f.manager.completion).rejects.toThrow('completion timed out')
    await expectReleased(f)
    expect(f.killHelper).not.toHaveBeenCalled()
  })

  it('times out from the terminal record when EOF arrives but physical helper exit does not', async () => {
    vi.useFakeTimers()
    const f = fixture(50, 20)
    const observe = vi.fn()
    void f.manager.completion.then(observe, observe)
    await f.setup()
    await vi.advanceTimersByTimeAsync(100)
    await f.history()
    await f.send(empty)
    await vi.advanceTimersByTimeAsync(19)
    const eof = once(f.control, 'end')
    f.helperControl.end()
    await eof
    f.child.emit('close', 0, null)
    await Promise.resolve()
    expect(observe).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(observe).toHaveBeenCalledExactlyOnceWith(expect.any(Error))
    await expect(f.manager.completion).rejects.toThrow('completion timed out')
    expect(f.control.destroyed).toBe(false)
    await vi.advanceTimersByTimeAsync(20)
    expect(f.killHelper).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    f.child.emit('exit', null, 'SIGKILL')
    await expectReleased(f)
  })

  it('rejects abort immediately and keeps the first error through the stable-handle fallback', async () => {
    vi.useFakeTimers()
    const f = fixture(500, 20)
    const firstError = new Error('original failure')
    const receipt = f.manager.completion
    await f.setup()
    f.manager.abort(firstError)
    await expect(receipt).rejects.toBe(firstError)
    expect(await f.receive()).toEqual({ type: 'stop', signal: 'SIGKILL' })
    await vi.advanceTimersByTimeAsync(19)
    f.manager.abort(new Error('late failure'))
    expect(f.control.destroyed).toBe(false)
    expect(f.killHelper).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.killHelper).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    expect(f.child.kill).not.toHaveBeenCalled()
    // A successful TerminateProcess request is not itself verified helper exit.
    expect(f.control.destroyed).toBe(false)
    f.child.emit('exit', null, 'SIGKILL')
    await expectReleased(f)
    expect(f.manager.completion).toBe(receipt)
    await expect(receipt).rejects.toBe(firstError)
  })

  it('bounds requested stop without another grace period or listener growth', async () => {
    vi.useFakeTimers()
    const f = fixture(500, 20)
    const exits = f.child.listenerCount('exit')
    for (let i = 0; i < 50; i++) expect(f.manager.stop()).toBe(true)
    expect(f.child.listenerCount('exit')).toBe(exits)
    await vi.advanceTimersByTimeAsync(20)
    await expect(f.manager.completion).rejects.toThrow('stop timed out')
    expect(f.killHelper).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    f.child.emit('exit', null, 'SIGKILL')
    await expectReleased(f)
  })

  it('does not change a settled success or signal the helper on late events', async () => {
    const f = fixture()
    await f.setup()
    await f.history()
    await f.send(empty)
    f.helperControl.end()
    f.child.emit('exit', 0, null)
    await expect(f.manager.completion).resolves.toBe('empty')
    f.child.emit('exit', 1, null)
    f.child.emit('close', 1, null)
    expect(f.killHelper).not.toHaveBeenCalled()
    f.close()
  })
})

describe('strict completion state', () => {
  it('does not let AUTH substitute for mode-bound SETUP', async () => {
    vi.useFakeTimers()
    const f = fixture(50)
    await f.send(hello)
    expect(await f.receive()).toEqual(auth)
    await vi.advanceTimersByTimeAsync(50)
    await expect(f.manager.completion).rejects.toThrow('setup timed out')
  })

  it('rejects a mode-mismatched SETUP', async () => {
    const f = fixture()
    await f.send(hello)
    await f.receive()
    await f.send(retainedSetup)
    await expect(f.manager.completion).rejects.toThrow('setup confirmation')
  })

  it('bounds partial-frame age from its first byte, not latest activity', async () => {
    vi.useFakeTimers()
    const f = fixture(15_000, 5000)
    await f.setup()
    f.helperControl.write('{')
    await vi.advanceTimersByTimeAsync(4999)
    f.helperControl.write(' ')
    await vi.advanceTimersByTimeAsync(1)
    await expect(f.manager.completion).rejects.toThrow('partial frame timed out')
  })

  it.each([
    { ...empty, exitCode: 259 },
    { ...empty, outputFailed: true },
    { ...empty, reason: 'stopped' as const, exitCode: 1 },
  ])('rejects contradictory EMPTY: %j', async (record) => {
    const f = fixture()
    await f.setup()
    await f.history()
    await f.send(record)
    await expect(f.manager.completion).rejects.toThrow('contradictory owned EMPTY')
  })

  it.each([259, 0x80000017])('keeps the full root DWORD %s', async (code) => {
    const f = fixture()
    await f.setup()
    await f.history(code)
    await f.send({ ...empty, exitCode: code, rootExitCode: code })
    f.helperControl.end()
    f.child.emit('exit', code | 0, null)
    await expect(f.manager.completion).resolves.toBe('empty')
  })

  it.each([{ type: 'ready' as const }, handoff])('rejects %j in ordinary mode', async (record) => {
    const f = fixture()
    await f.setup()
    await f.send(record)
    await expect(f.manager.completion).rejects.toThrow()
  })

  it.each<{ name: string; history: OwnedProcessMessage[]; terminal: OwnedProcessMessage }>([
    { name: 'missing creation and exit', history: [], terminal: empty },
    { name: 'missing exit', history: [created], terminal: empty },
    { name: 'missing creation', history: [exited], terminal: empty },
    { name: 'duplicate creation', history: [created, created], terminal: empty },
    {
      name: 'conflicting creation',
      history: [created, { ...created, rootPid: 71 }],
      terminal: empty,
    },
    {
      name: 'conflicting exit PID',
      history: [created, { ...exited, rootPid: 71 }],
      terminal: empty,
    },
    { name: 'duplicate exit', history: [created, exited, exited], terminal: empty },
    {
      name: 'conflicting exit status',
      history: [created, exited, { ...exited, rootExitCode: 259 }],
      terminal: empty,
    },
    { name: 'EMPTY PID mismatch', history: [created, exited], terminal: { ...empty, rootPid: 71 } },
    {
      name: 'EMPTY status mismatch',
      history: [created, exited],
      terminal: { ...empty, exitCode: 259, rootExitCode: 259 },
    },
    {
      name: 'launch failure after root creation',
      history: [created],
      terminal: {
        ...empty,
        reason: 'launch-failed',
        exitCode: 125,
        rootPid: null,
        rootExitCode: null,
      },
    },
    {
      name: 'diagnostic in place of creation',
      history: [
        { type: 'phase', phase: 'after-root-resume', rootPid: 70, state: 'running' },
        exited,
      ],
      terminal: empty,
    },
  ])(
    'rejects $name even with matching helper status and clean EOF',
    async ({ history, terminal }) => {
      const f = fixture()
      await f.setup()
      for (const record of history) await f.send(record)
      await f.send(terminal)
      f.helperControl.end()
      f.child.emit('exit', 'exitCode' in terminal ? terminal.exitCode : 0, null)
      await expect(f.manager.completion).rejects.toThrow(
        /owned (?:root|terminal contradicts|EMPTY)/,
      )
    },
  )

  it('rejects HANDOFF for a different root than the one ready to retain', async () => {
    const f = fixture(500, 500, 'retained')
    await f.setup()
    await f.history()
    await f.send({ type: 'ready' })
    expect(f.manager.acknowledgeSuccess()).toBe(true)
    await f.send({ ...handoff, rootPid: 71 })
    f.helperControl.end()
    f.child.emit('exit', 0, null)
    await expect(f.manager.completion).rejects.toThrow('contradicts root history')
  })

  it.each([false, true])('accepts rootless EMPTY before creation (STOP: %s)', async (stop) => {
    const f = fixture()
    await f.setup()
    if (stop) {
      expect(f.manager.stop()).toBe(true)
      await f.receive()
    }
    const exitCode = stop ? 1 : 125
    await f.send({
      ...empty,
      exitCode,
      rootExitCode: null,
      rootPid: null,
      reason: stop ? 'stopped' : 'launch-failed',
    })
    f.helperControl.end()
    f.child.emit('exit', exitCode, null)
    await expect(f.manager.completion).resolves.toBe('empty')
  })

  it('cannot use pre-creation STOP for a root whose creation was already recorded', async () => {
    const f = fixture()
    await f.setup()
    await f.send(created)
    expect(f.manager.stop()).toBe(true)
    await f.send({ ...empty, exitCode: 1, rootExitCode: null, rootPid: null, reason: 'stopped' })
    await expect(f.manager.completion).rejects.toThrow('contradicts root history')
  })

  it('still sends STOP after ACK', async () => {
    const f = fixture(500, 500, 'retained')
    await f.setup()
    await f.history()
    await f.send({ type: 'ready' })
    expect(f.manager.acknowledgeSuccess()).toBe(true)
    expect(await f.receive()).toEqual({ type: 'acknowledge' })
    expect(f.manager.stop()).toBe(true)
    expect(await f.receive()).toEqual({ type: 'stop', signal: 'SIGTERM' })
    await f.send({ ...empty, exitCode: 1, reason: 'stopped' })
    f.helperControl.end()
    f.child.emit('exit', 1, null)
    await expect(f.manager.completion).resolves.toBe('empty')
  })
})

it('binds the authenticated parent epoch before writing AUTH', async () => {
  const bind = vi.fn(() => {
    throw new Error('admission frozen')
  })
  const f = fixture(500, 500, 'retained', bind)
  const writes = vi.spyOn(f.control, 'write')
  await f.send(hello)
  expect(bind).toHaveBeenCalledExactlyOnceWith(hello)
  expect(writes).not.toHaveBeenCalled()
  await expect(f.manager.completion).rejects.toThrow('admission frozen')
})

it('does not acknowledge SETUP from a different parent epoch', async () => {
  const f = fixture(500, 500, 'retained')
  await f.send(hello)
  expect(await f.receive()).toMatchObject({ type: 'auth' })
  await f.send({ ...retainedSetup, parentBirth: '100001' })
  await expect(f.manager.completion).rejects.toThrow('setup confirmation')
  expect(await f.receive()).toEqual({ type: 'stop', signal: 'SIGKILL' })
})
