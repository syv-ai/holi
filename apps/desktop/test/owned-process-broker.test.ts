import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { brokerFailureDiagnostic, ownedJobLease } from '../src/main/owned-process-broker'
import { createOwnedProtocol, type OwnedProcessMessage } from '../src/main/owned-process-protocol'

const spawnBroker = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: spawnBroker }))

const ticket = {
  launchId: 'launch',
  secret: Buffer.alloc(32),
  jobId: '11111111-1111-4111-8111-111111111111',
  parentPid: 5,
  parentBirth: '100000',
  jobHandle: 'a4',
  commitGuardId: '22222222-2222-4222-8222-222222222222',
  commitGuardHandle: 'b4',
}

const prepared = {
  launchId: ticket.launchId,
  secret: ticket.secret,
  parentPid: ticket.parentPid,
  jobId: ticket.jobId,
  commitGuardId: ticket.commitGuardId,
}
type Broker = NonNullable<Parameters<typeof ownedJobLease>[0]['broker']>
function adoptedLease(broker?: Broker) {
  const job = ownedJobLease({ prepared, joinProducer: async () => {}, ...(broker && { broker }) })
  job.bindForAuth(ticket.parentBirth)
  job.adopt(ticket)
  return job
}

function staged() {
  let grant!: () => boolean
  let committed!: () => void
  let resolve!: () => void
  let reject!: (reason: Error) => void
  let prepare!: () => void
  const prepared = new Promise<void>((res) => {
    prepare = res
  })
  const broker = vi.fn<Broker>()
  broker.mockImplementation((_ticket, action, authorize, confirm) => {
    if (action === 'revoke') {
      expect(authorize()).toBe(true)
      return Promise.resolve()
    }
    grant = authorize
    committed = confirm!
    return new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
      prepare()
    })
  })
  const job = adoptedLease(broker)
  job.handedOff()
  return {
    job,
    broker,
    prepared,
    grant: () => grant(),
    committed: () => committed(),
    resolve: () => resolve(),
    reject: (e: Error) => reject(e),
  }
}

describe('retained native Job lease', () => {
  it('gives stop priority before the release grant and joins the preparing broker before revoke', async () => {
    const f = staged()
    const commit = f.job.lease.commit()
    expect(f.job.lease.commit()).toBe(commit)
    const first = new Error('release lost to stop')
    const rejected = expect(commit).rejects.toBe(first)
    await f.prepared
    const revoke = f.job.lease.revoke()
    expect(f.job.lease.revoke()).toBe(revoke)
    expect(f.grant()).toBe(false)
    expect(f.broker).toHaveBeenCalledTimes(1)
    f.reject(first)
    await rejected
    await revoke
    expect(f.broker.mock.calls.map(([, action]) => action)).toEqual(['release', 'revoke'])
    expect(f.broker.mock.calls[1]?.[0]).toEqual(ticket)
  })

  it.each(['closed', 'unknown'])(
    'does not reopen a %s source slot after a verified native commit',
    async (result) => {
      const f = staged()
      const commit = f.job.lease.commit()
      await f.prepared
      expect(f.grant()).toBe(true)
      expect(f.job.markStop()).toBe(false)
      f.committed()
      if (result === 'closed') f.resolve()
      else f.reject(new Error('broker died around close'))
      await commit
      await expect(f.job.lease.revoke()).rejects.toThrow('already committed')
      expect(f.job.lease.commit()).toBe(commit)
      expect(f.broker).toHaveBeenCalledTimes(1)
    },
  )

  it('retains the exact source when the broker dies before the release grant', async () => {
    const f = staged()
    const commit = f.job.lease.commit()
    await f.prepared
    const first = new Error('broker aborted during preparation')
    const rejected = expect(commit).rejects.toBe(first)
    f.reject(first)
    await rejected
    await f.job.lease.revoke()
    expect(f.broker.mock.calls.map(([value]) => value)).toEqual([ticket, ticket])
  })

  it('waits for a granted but unproved release, then revokes the still-held pair', async () => {
    const f = staged()
    const commit = f.job.lease.commit()
    await f.prepared
    expect(f.grant()).toBe(true)
    const revoke = f.job.lease.revoke()
    expect(f.broker).toHaveBeenCalledTimes(1)
    const first = new Error('cannot verify commit guard clear')
    const rejected = expect(commit).rejects.toBe(first)
    f.reject(first)
    await rejected
    await revoke
    expect(f.broker.mock.calls.map(([ticket, action]) => [ticket, action])).toEqual([
      [ticket, 'release'],
      [ticket, 'revoke'],
    ])
  })

  it('does not infer native commit from a broker exit after grant', async () => {
    const f = staged()
    const commit = f.job.lease.commit()
    await f.prepared
    expect(f.grant()).toBe(true)
    f.resolve()
    await expect(commit).rejects.toThrow('did not prove native commit')
    expect(f.job.markStop()).toBe(true)
    await f.job.lease.revoke()
    expect(f.broker).toHaveBeenCalledTimes(2)
  })

  it('never retries a revoke after a lost drain/close receipt', async () => {
    const first = new Error('broker died')
    const broker = vi.fn(async (_ticket, _action, grant) => {
      expect(grant()).toBe(true)
      throw first
    })
    const job = adoptedLease(broker)
    const revoke = job.lease.revoke()
    await expect(revoke).rejects.toBe(first)
    expect(job.lease.revoke()).toBe(revoke)
    expect(broker).toHaveBeenCalledTimes(1)
    await expect(job.lease.commit()).rejects.toThrow()
  })
})

// The real parent controller talks to real authenticated frames. These children
// model transport failure only; kernel rollback is covered by the Windows fixture.
function wireChild(stdin = new PassThrough()) {
  const child = Object.assign(new EventEmitter(), {
    pid: 6,
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  })
  let spec!: Omit<typeof ticket, 'secret'> & { secret: string; action: Parameters<Broker>[1] }
  let helper!: ReturnType<typeof createOwnedProtocol>
  const commands: OwnedProcessMessage[] = []
  child.stdin.on('data', (chunk: Buffer) => {
    if (helper) commands.push(...helper.push(chunk))
    else {
      spec = JSON.parse(chunk.toString())
      helper = createOwnedProtocol({
        launchId: spec.launchId,
        secret: Buffer.from(spec.secret, 'base64'),
        role: 'helper',
      })
    }
  })
  const binding = { jobId: ticket.jobId, commitGuardId: ticket.commitGuardId }
  return {
    child,
    commands,
    get spec() {
      return spec
    },
    send(message: OwnedProcessMessage) {
      child.stdout.write(helper.encode(message))
    },
    ready() {
      this.send({ type: 'brokerReady', ...binding })
    },
    cleared() {
      this.send({ type: 'committed', ...binding })
    },
    decision() {
      this.send({ type: 'phase', phase: 'commit-observed', state: 'clear', rootPid: null })
    },
    drained() {
      this.send({ type: 'drained', ...binding })
    },
    released() {
      this.send({ type: 'released', ...binding })
    },
    async eof() {
      const end = once(child.stdout, 'end')
      child.stdout.end()
      await end
    },
  }
}

async function preparingWireLease(signal?: AbortSignal) {
  const release = wireChild()
  const cleanup = wireChild()
  const recoveryStarted = new Promise<void>((resolve) => {
    spawnBroker
      .mockReset()
      .mockReturnValueOnce(release.child)
      .mockImplementationOnce(() => {
        resolve()
        return cleanup.child
      })
  })
  const job = adoptedLease()
  job.handedOff()
  const commit = job.lease.commit(signal)
  const outcome = commit.catch((error: unknown) => error)
  await Promise.resolve()
  expect(spawnBroker.mock.calls[0]?.[2]).toMatchObject({
    detached: true,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return { job, commit, outcome, release, cleanup, recoveryStarted }
}

async function wireLease(signal?: AbortSignal) {
  const wire = await preparingWireLease(signal)
  wire.release.ready()
  expect(wire.release.commands).toMatchObject([{ type: 'grant', action: 'release' }])
  return wire
}

describe('native commit observation protocol', () => {
  it('does not spawn a release broker for an already revoked activation', async () => {
    spawnBroker.mockReset()
    const cleanup = wireChild()
    spawnBroker.mockReturnValueOnce(cleanup.child)
    const job = adoptedLease()
    job.handedOff()
    const reason = new Error('activation already revoked')
    await expect(job.lease.commit(AbortSignal.abort(reason))).rejects.toBe(reason)
    expect(spawnBroker).not.toHaveBeenCalled()
    const revoke = job.lease.revoke()
    await vi.waitFor(() => expect(cleanup.spec?.action).toBe('revoke'))
    cleanup.ready()
    cleanup.drained()
    await cleanup.eof()
    cleanup.child.emit('close', 0, null)
    await revoke
    expect(spawnBroker).toHaveBeenCalledTimes(1)
  })

  it.each(['late READY', 'READY during abort dispatch'] as const)(
    'sends no release grant and joins the cached revoke of the original slots (%s)',
    async (timing) => {
      const owner = new AbortController()
      let atAbort = () => {}
      // This listener precedes the broker's, so READY can exercise admission
      // before the broker receives its abort notification.
      owner.signal.addEventListener('abort', () => atAbort(), { once: true })
      const { release, cleanup, job, commit, outcome, recoveryStarted } = await preparingWireLease(
        owner.signal,
      )
      const reason = new Error('activation revoked while preparing')
      if (timing === 'READY during abort dispatch') atAbort = () => release.ready()
      owner.abort(reason)
      if (timing === 'late READY') release.ready()
      expect(release.commands).toEqual([])
      expect(release.child.stdin.destroyed).toBe(true)
      expect(release.child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
      const revoke = job.lease.revoke()
      expect(job.lease.revoke()).toBe(revoke)
      expect(job.lease.commit()).toBe(commit)
      await Promise.resolve()
      expect(spawnBroker).toHaveBeenCalledTimes(1)
      release.child.emit('close', null, 'SIGKILL')
      expect(await outcome).toBe(reason)
      await recoveryStarted
      expect(cleanup.spec).toMatchObject({
        action: 'revoke',
        jobId: ticket.jobId,
        jobHandle: ticket.jobHandle,
        commitGuardId: ticket.commitGuardId,
        commitGuardHandle: ticket.commitGuardHandle,
        parentPid: ticket.parentPid,
        parentBirth: ticket.parentBirth,
      })
      cleanup.ready()
      expect(cleanup.commands).toMatchObject([{ type: 'grant', action: 'revoke' }])
      cleanup.drained()
      await cleanup.eof()
      cleanup.child.emit('close', 0, null)
      await revoke
      expect(spawnBroker).toHaveBeenCalledTimes(2)
    },
  )

  it.each(['ordinary error', 'hostile proxy'] as const)(
    'keeps concurrent broker diagnostics separate for a shared abort reason (%s)',
    async (kind) => {
      const underlying = new Error('stop requested')
      const target = Object.assign(new Error('activation revoked', { cause: underlying }), {
        code: 'ABORT_ERR',
      })
      const trap = vi.fn(() => {
        target.code = 'CORRUPTED'
        target.message = 'changed by a proxy trap'
        target.cause = undefined
        throw new Error('abort reason must not be inspected')
      })
      const reason =
        kind === 'hostile proxy'
          ? new Proxy(target, {
              get: trap,
              has: trap,
              getPrototypeOf: trap,
              getOwnPropertyDescriptor: trap,
              defineProperty: trap,
              set: trap,
              isExtensible: trap,
              preventExtensions: trap,
            })
          : target
      const owner = new AbortController()
      const diagnostics = [
        { phase: 'open-jobs', code: 5 },
        { phase: 'scan-objects', code: 3221225506 },
        undefined,
      ]
      const children = diagnostics.map(() => ({ release: wireChild(), cleanup: wireChild() }))
      spawnBroker.mockReset()
      for (const { release } of children) spawnBroker.mockReturnValueOnce(release.child)
      for (const { cleanup } of children) spawnBroker.mockReturnValueOnce(cleanup.child)
      const operations = children.map((wire) => {
        const job = adoptedLease()
        job.handedOff()
        const commit = job.lease.commit(owner.signal)
        // Compare identity in the rejection handler, without inspecting the
        // reason or returning it as a potential thenable.
        const rejected = commit.then(
          () => false,
          (error: unknown) => error === reason,
        )
        return { ...wire, job, commit, rejected }
      })
      await Promise.resolve()
      expect(spawnBroker).toHaveBeenCalledTimes(operations.length)
      owner.abort(reason)
      const revokes = operations.map(({ job }) => job.lease.revoke())
      for (const [i, { release, commit, rejected, cleanup }] of operations.entries()) {
        expect(release.commands).toEqual([])
        expect(release.child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
        expect(brokerFailureDiagnostic(commit)).toBeUndefined()
        const diagnostic = diagnostics[i]
        const stderrClosed = once(release.child.stderr, 'close')
        release.child.stderr.end(
          diagnostic ? `HOLI_BROKER_FAILURE ${diagnostic.phase} ${diagnostic.code}\n` : '',
        )
        await stderrClosed
        release.child.emit('close', null, 'SIGKILL')
        expect(await rejected).toBe(true)
        expect(brokerFailureDiagnostic(commit)).toStrictEqual(diagnostic)
        await vi.waitFor(() => expect(cleanup.spec?.action).toBe('revoke'))
        cleanup.ready()
        cleanup.drained()
        await cleanup.eof()
        cleanup.child.emit('close', 0, null)
        await revokes[i]
      }
      for (const [i, { job, commit }] of operations.entries()) {
        expect(job.lease.commit()).toBe(commit)
        expect(await job.lease.commit().catch((error: unknown) => error === reason)).toBe(true)
        expect(brokerFailureDiagnostic(commit)).toStrictEqual(diagnostics[i])
        const revoke = job.lease.revoke()
        expect(revoke).toBe(revokes[i])
        expect(brokerFailureDiagnostic(revoke)).toBeUndefined()
      }
      expect(trap).not.toHaveBeenCalled()
      expect(target).toMatchObject({ message: 'activation revoked', code: 'ABORT_ERR' })
      expect(target.cause).toBe(underlying)
      expect(target).not.toHaveProperty('nativeFailure')
      expect(spawnBroker).toHaveBeenCalledTimes(2 * operations.length)
    },
  )

  it('lets an admitted release finish its native decision and close after activation abort', async () => {
    const owner = new AbortController()
    const { release, job, commit } = await wireLease(owner.signal)
    owner.abort()
    expect(job.markStop()).toBe(false)
    const revoke = job.lease.revoke()
    const denied = expect(revoke).rejects.toThrow('already committed')
    release.cleared()
    expect(release.commands.map(({ type }) => type)).toEqual(['grant', 'acknowledge'])
    expect(release.child.stdin.destroyed).toBe(false)
    expect(spawnBroker).toHaveBeenCalledTimes(1)
    release.decision()
    expect(release.commands.at(-1)).toMatchObject({ type: 'closeSources' })
    release.released()
    await release.eof()
    expect(release.child.kill).not.toHaveBeenCalled()
    release.child.emit('close', 0, null)
    await commit
    await denied
    expect(job.lease.revoke()).toBe(revoke)
    expect(spawnBroker).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['parent gone before send', 'parentUnavailable', false],
    ['committed write failure', 'controlFailure', false],
    ['invalid OBSERVED acknowledgement', 'protocolFailure', true],
    ['OBSERVED timeout in the broker', 'controlFailure', true],
    ['EOF after guard clear', null, true],
    ['OBSERVED write failure', new Error('broken acknowledgement pipe'), true],
    ['broker hard crash after clear', null, false],
  ] as const)(
    'retains rollback authority and the first cause on %s',
    async (_name, failure, cleared) => {
      const owner = new AbortController()
      const { release, cleanup, job, commit, outcome, recoveryStarted } = await wireLease(
        owner.signal,
      )
      owner.abort()
      if (cleared) {
        release.cleared()
        expect(release.commands.at(-1)).toEqual({ type: 'acknowledge' })
      }
      if (typeof failure === 'string') release.send({ type: 'error', code: failure })
      else if (failure) release.child.stdin.emit('error', failure)
      else if (cleared) await release.eof()
      expect(release.commands.every(({ type }) => type !== 'closeSources')).toBe(true)
      expect(release.child.kill).not.toHaveBeenCalled()
      expect(spawnBroker).toHaveBeenCalledTimes(1) // Rollback still owns its duplicates.
      release.child.emit('close', 125, null)
      const cause = await outcome
      if (typeof failure === 'string')
        expect(cause).toMatchObject({ message: `owned Job broker reported ${failure}` })
      else if (failure) expect(cause).toBe(failure)
      else expect(cause).toBeInstanceOf(Error)
      expect(job.lease.commit()).toBe(commit)
      // Recovery starts without an external revoke and reuses both original slots.
      await recoveryStarted
      expect(spawnBroker).toHaveBeenCalledTimes(2)
      expect(cleanup.spec).toMatchObject({
        ...ticket,
        secret: ticket.secret.toString('base64'),
        launchId: expect.any(String),
      })
      expect(cleanup.spec.launchId).not.toBe(release.spec.launchId)
      const revoke = job.lease.revoke()
      expect(job.lease.revoke()).toBe(revoke)
      cleanup.ready()
      expect(cleanup.commands).toMatchObject([{ type: 'grant', action: 'revoke' }])
      cleanup.drained()
      await cleanup.eof()
      cleanup.child.emit('close', 0, null)
      await revoke
    },
  )

  it('lets the native rollback finish when the parent ACK deadline expires', async () => {
    vi.useFakeTimers()
    try {
      const { release, cleanup, job, outcome, recoveryStarted } = await wireLease()
      release.cleared()
      await vi.advanceTimersByTimeAsync(5000)
      expect(release.child.stdin.destroyed).toBe(true)
      expect(release.child.kill).not.toHaveBeenCalled()
      expect(spawnBroker).toHaveBeenCalledTimes(1)
      release.child.emit('close', 125, null)
      expect(await outcome).toMatchObject({ message: 'owned Job broker cleanup timed out' })
      const revoke = job.lease.revoke()
      await recoveryStarted
      // An exit without a native zero receipt must not settle the cleanup as EMPTY.
      cleanup.ready()
      await cleanup.eof()
      cleanup.child.emit('close', 0, null)
      await expect(revoke).rejects.toThrow('ended without proof')
      expect(job.lease.revoke()).toBe(revoke)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['complete', 'close lost', 'abnormal exit'] as const)(
    'does not reopen the source slots after accepted OBSERVED (%s)',
    async (result) => {
      const { release, job, commit } = await wireLease()
      release.cleared()
      expect(release.commands.map(({ type }) => type)).toEqual(['grant', 'acknowledge'])
      release.decision()
      expect(release.commands.map(({ type }) => type)).toEqual([
        'grant',
        'acknowledge',
        'closeSources',
      ])
      if (result !== 'close lost') release.released()
      await release.eof()
      release.child.emit('close', result === 'abnormal exit' ? 125 : 0, null)
      await commit
      await expect(job.lease.revoke()).rejects.toThrow('already committed')
      expect(spawnBroker).toHaveBeenCalledTimes(1)
    },
  )
})

const recovery = {
  type: 'recovered',
  action: 'recover',
  parentPid: prepared.parentPid,
  parentBirth: ticket.parentBirth,
  jobId: prepared.jobId,
  commitGuardId: prepared.commitGuardId,
  jobState: 'closed-zero',
  jobBefore: 1,
  jobAfter: 0,
  jobActiveBefore: 0,
  jobActiveAfter: 0,
  guardState: 'absent',
  guardBefore: null,
  guardAfter: null,
  guardActiveBefore: null,
  guardActiveAfter: null,
} as const

async function pendingWire(stdin?: PassThrough) {
  const native = wireChild(stdin)
  spawnBroker.mockReset().mockReturnValueOnce(native.child)
  let exited!: () => void
  const exit = new Promise<void>((resolve) => {
    exited = resolve
  })
  const joinProducer = vi.fn(() => exit)
  const job = ownedJobLease({ prepared, joinProducer })
  job.bindForAuth(ticket.parentBirth)
  const revoke = job.lease.revoke()
  const outcome = revoke.catch((error: unknown) => error)
  expect(() => job.adopt(ticket)).toThrow('cannot adopt')
  expect(() => job.bindForAuth(ticket.parentBirth)).toThrow('cannot bind')
  await Promise.resolve()
  expect(spawnBroker).not.toHaveBeenCalled()
  expect(joinProducer).toHaveBeenCalledTimes(1)
  exited()
  await Promise.resolve()
  expect(native.spec).toMatchObject({ action: 'recover', parentBirth: ticket.parentBirth })
  expect(native.spec).not.toHaveProperty('jobHandle')
  expect(native.spec).not.toHaveProperty('commitGuardHandle')
  native.ready()
  expect(native.commands).toMatchObject([{ type: 'grant', action: 'recover' }])
  return { native, job, revoke, outcome }
}

describe('pending recovery proof', () => {
  it.each([
    ['diagnostic before stdout EOF', 'EOF', true],
    ['EPIPE before diagnostic and stdout close', 'EPIPE', true],
    ['frozen EPIPE before diagnostic and stdout close', 'frozen EPIPE', true],
    ['malformed and oversized diagnostics after EPIPE', 'EPIPE', false],
  ] as const)(
    'joins physical close and preserves the first cause: %s',
    async (_case, transport, valid) => {
      let finishClose!: () => void
      const stdin = new PassThrough({
        destroy(error, done) {
          finishClose = () => done(error)
        },
      })
      const { native, job, revoke, outcome } = await pendingWire(stdin)
      const settled = vi.fn()
      void outcome.then(settled)
      const inputClose = new Promise<void>((resolve) => stdin.once('close', resolve))
      const readableClose = Promise.all([
        once(native.child.stdout, 'close'),
        once(native.child.stderr, 'close'),
      ])
      const underlying = new Error('write failed')
      const first = Object.assign(new Error('write EPIPE', { cause: underlying }), {
        code: 'EPIPE',
      })
      if (transport === 'frozen EPIPE') Object.freeze(first)
      if (transport !== 'EOF') {
        // Queue EOF, then make the transport error win before the 'end' event.
        native.child.stdout.end()
        expect(native.child.stdout.readableEnded).toBe(false)
        stdin.emit('error', first)
      }
      native.child.stderr.write(`untrusted diagnostic: ${JSON.stringify(native.spec)}\n`)
      if (valid) {
        native.child.stderr.write('HOLI_BROKER_FAILURE scan-objects ')
        native.child.stderr.end('3221225506\n')
      } else {
        native.child.stderr.write(`HOLI_BROKER_FAILURE ${ticket.jobId} 5\n`)
        native.child.stderr.write('HOLI_BROKER_FAILURE scan-objects 4294967296\n')
        native.child.stderr.write(`HOLI_BROKER_FAILURE scan-objects ${'9'.repeat(100)}\n`)
        native.child.stderr.end(`HOLI_BROKER_FAILURE scan-objects 5 ${ticket.jobHandle}\n`)
      }
      if (transport === 'EOF') await native.eof()
      await readableClose
      expect(settled).not.toHaveBeenCalled()
      expect(native.child.kill).not.toHaveBeenCalled()
      native.child.emit('close', 125, null)
      await Promise.resolve()
      expect(settled).not.toHaveBeenCalled() // ChildProcess close does not join stdin.
      expect(brokerFailureDiagnostic(revoke)).toBeUndefined()
      finishClose()
      await inputClose
      const cause = await outcome
      if (transport === 'EOF')
        expect(cause).toMatchObject({ message: 'owned Job broker ended without proof' })
      else {
        expect(cause).toBe(first)
        expect(first).toMatchObject({ message: 'write EPIPE', code: 'EPIPE' })
        expect(first.cause).toBe(underlying)
      }
      const metadata = valid ? { phase: 'scan-objects', code: 3221225506 } : undefined
      expect(brokerFailureDiagnostic(revoke)).toStrictEqual(metadata)
      expect(cause).not.toHaveProperty('nativeFailure')
      expect(job.lease.revoke()).toBe(revoke)
      await expect(job.lease.revoke()).rejects.toBe(cause)
      expect(spawnBroker).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    [
      'both absent',
      {
        ...recovery,
        jobState: 'absent',
        jobBefore: null,
        jobAfter: null,
        jobActiveBefore: null,
        jobActiveAfter: null,
      },
    ],
    ['only the first duplicated', recovery],
    [
      'both duplicated',
      {
        ...recovery,
        guardState: 'closed-zero',
        guardBefore: 1,
        guardAfter: 0,
        guardActiveBefore: 0,
        guardActiveAfter: 0,
      },
    ],
  ] as const)('waits for native evidence, EOF and close with %s', async (_case, terminal) => {
    const { native, job, revoke } = await pendingWire()
    const done = vi.fn()
    void revoke.then(done)
    native.send(terminal)
    await native.eof()
    expect(done).not.toHaveBeenCalled()
    native.child.emit('close', 0, null)
    await revoke
    expect(job.lease.revoke()).toBe(revoke)
  })

  it.each([
    ['missing match or ambiguous scan', { type: 'error', code: 'nativeQueryFailure' }, 125],
    ['wrong parent PID', { ...recovery, parentPid: 6 }, 0],
    ['wrong parent birth', { ...recovery, parentBirth: '100001' }, 0],
    ['wrong job IDs', { ...recovery, jobId: '33333333-3333-4333-8333-333333333333' }, 0],
    [
      'wrong action receipt',
      { type: 'drained', jobId: prepared.jobId, commitGuardId: prepared.commitGuardId },
      0,
    ],
    ['lost proof after close', undefined, 0],
    ['nonzero native status after terminal', recovery, 125],
  ] as const)('keeps UNKNOWN sticky: %s', async (_case, terminal, code) => {
    const { native, job, revoke, outcome } = await pendingWire()
    if (terminal) native.send(terminal)
    if (!native.child.stdout.destroyed) await native.eof()
    native.child.emit('close', code, null)
    expect(await outcome).toBeInstanceOf(Error)
    expect(job.lease.revoke()).toBe(revoke)
    expect(spawnBroker).toHaveBeenCalledTimes(1)
    expect(native.child.kill).not.toHaveBeenCalled()
  })

  it('does not bind or spend a recovery broker if revoked before AUTH', async () => {
    const broker = vi.fn<Broker>()
    const job = ownedJobLease({ prepared, joinProducer: async () => {}, broker })
    const done = job.lease.revoke()
    expect(() => job.bindForAuth(ticket.parentBirth)).toThrow('cannot bind')
    await done
    expect(broker).not.toHaveBeenCalled()
  })
})
