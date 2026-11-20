import { ChildProcess, spawn, type SpawnOptions } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { inspect } from 'node:util'
import type { Launch } from './launch'
import { ownedJobLease } from './owned-process-broker'
import type { PrivateCompletion, PrivateManagedOwnedChild } from './owned-process-completion'
import { ownedControlTransport } from './owned-process-control-transport'
import { completionStream } from './owned-process-stream'
import { win32Adapter } from './owned-process-win32'
import {
  UnconfirmedOwnedProgramError,
  type ManagedOwnedChild,
  type OwnedCompletion,
  type RetainedExecMetadata,
} from './owned-program-lifetime'

type RetainedOwnedProgramLease = NonNullable<
  Extract<RetainedExecMetadata, { kind: 'settled' }>['lease']
>

type PrivateOwnedChild = PrivateManagedOwnedChild & {
  readonly ownedCompletion: Promise<PrivateCompletion>
}
interface PrivateLaunch {
  readonly lease: RetainedOwnedProgramLease
  /** The original revoke promise once started, not the native Job-zero receipt.
   * A successful HANDOFF leaves cleanup admission with the lease owner. */
  readonly resourceCleanup: Promise<void> | undefined
  readonly identity: Promise<{ pid: number; birth: string; launchId: string }>
  /** Private physical pipe join, after the original completion settles. */
  joinControlClose(): Promise<void>
  acknowledge(): boolean
  onReady?: () => void
  onOutputFailure?: (error: Error) => void
  readonly stopped: boolean
  diagnostics(): {
    helperLastPhase: string
    helperStarted: boolean
    rootStarted: boolean
    helperPid: number | null
    rootPid: number | null
    rootState: string
  }
}
const launches = new WeakMap<ChildProcess, PrivateLaunch>()
export function ownedLaunchControl(child: ChildProcess) {
  return launches.get(child)
}

/** Native fixture pinning only, not a plugin interface. @public */
export function ownedHelperIdentity(child: ChildProcess) {
  return (
    launches.get(child)?.identity ??
    Promise.reject(new Error('no native helper identity for launch'))
  )
}

/** Raw producer command for the native fixtures. @public */
export function windowsAdapterLaunch(env: NodeJS.ProcessEnv) {
  return win32Adapter('Run', env)
}

type WindowsOwnedChild = ManagedOwnedChild & { readonly ownedCompletion: Promise<OwnedCompletion> }

/** Used only when the launch failed before a helper could be created. */
export function notStartedOwnedChild(failure: unknown): WindowsOwnedChild {
  const child = Object.assign(new ChildProcess(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    ownedCompletion: Promise.resolve<OwnedCompletion>('not-started'),
  })
  child.stdin.on('error', () => undefined)
  let openStreams = 3
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream.once('close', () => {
      if (--openStreams === 0) child.emit('close', null, null)
    })
  }
  process.nextTick(() => {
    child.emit('error', failure)
    child.stdin.destroy()
    child.stdout.resume().end()
    child.stderr.resume().end()
  })
  return child
}

export function spawnOwnedLaunch(
  plan: Launch,
  options: SpawnOptions,
  parentPid: number,
  retainDescendantsOnSuccess?: false,
): WindowsOwnedChild
export function spawnOwnedLaunch(
  plan: Launch,
  options: SpawnOptions,
  parentPid: number,
  retainDescendantsOnSuccess: boolean,
): PrivateOwnedChild
export function spawnOwnedLaunch(
  plan: Launch,
  options: SpawnOptions,
  parentPid: number,
  retainDescendantsOnSuccess = false,
): PrivateOwnedChild {
  return launchOwned(plan, options, parentPid, retainDescendantsOnSuccess)
}

/** Internal producer with a native-fixture-only fault seam. @public */
export function launchOwned(
  plan: Launch,
  options: SpawnOptions,
  parentPid: number,
  retainDescendantsOnSuccess: boolean,
  testFault?:
    | 'query'
    | 'before-clear'
    | 'after-clear'
    | 'before-first-dup'
    | 'after-first-dup'
    | 'after-both-dups'
    | 'drop-registered'
    | 'registration-stop-audit',
  registrationFixture?: {
    pauseAuth?(
      identity: { pid: number; birth: string; parentBirth: string },
      jobs: { jobId: string; commitGuardId: string } | undefined,
    ): Promise<void>
    beforeJoin?(): Promise<void>
    adopted?(slots: { jobHandle: string; commitGuardHandle: string }): void
    broker?: NonNullable<Parameters<typeof ownedJobLease>[0]['broker']>
  },
): PrivateOwnedChild {
  const { signal, timeout, ...helperOptions } = options
  // Like Node's spawn, reject invalid budgets synchronously, before creating a helper.
  if (timeout != null && !(Number.isInteger(timeout) && timeout >= 0)) {
    throw Object.assign(
      new RangeError(
        `The value of "timeout" is out of range. It must be an unsigned integer. Received ${inspect(timeout)}`,
      ),
      { code: 'ERR_OUT_OF_RANGE' },
    )
  }
  const cwd =
    options.cwd instanceof URL ? fileURLToPath(options.cwd) : resolve(options.cwd ?? process.cwd())
  const launchEnv = { ...(options.env ?? process.env) }
  let traceEnabled = false
  for (const key of Object.keys(launchEnv)) {
    if (key.toUpperCase() === 'HOLI_OWNED_PROCESS_TRACE') {
      traceEnabled ||= launchEnv[key] === '1'
      delete launchEnv[key]
    }
  }
  const helperLaunch = windowsAdapterLaunch(launchEnv)
  if (signal?.aborted) return notStartedOwnedChild(abortError(signal))
  const spawnOptions: SpawnOptions = {
    // Node still validates killSignal, but neither timeout nor signal may act
    // directly on the helper.
    ...helperOptions,
    cwd: helperLaunch.cwd,
    env: launchEnv,
    shell: false,
    windowsVerbatimArguments: false,
    detached: false,
    windowsHide: true,
    stdio: [
      'pipe',
      Array.isArray(options.stdio)
        ? (options.stdio[1] ?? 'pipe')
        : options.stdio === 'ignore' || options.stdio === 'inherit'
          ? options.stdio
          : 'pipe',
      Array.isArray(options.stdio)
        ? (options.stdio[2] ?? 'pipe')
        : options.stdio === 'ignore' || options.stdio === 'inherit'
          ? options.stdio
          : 'pipe',
    ] as SpawnOptions['stdio'],
  }
  const launchId = randomUUID()
  const secret = randomBytes(32)
  const jobs = retainDescendantsOnSuccess
    ? { jobId: randomUUID(), commitGuardId: randomUUID() }
    : undefined
  const job = ownedJobLease({
    prepared: jobs && { ...jobs, launchId, secret, parentPid },
    joinProducer,
    broker: registrationFixture?.broker,
  })
  const controlPipe = `holi-owned-${randomUUID()}`
  const stdoutMarker = `\\n[holi-complete-${randomUUID()}-stdout]\\n`
  const stderrMarker = `\\n[holi-complete-${randomUUID()}-stderr]\\n`
  const spec = JSON.stringify({
    launchId,
    secret: secret.toString('base64'),
    controlPipe,
    bin: plan.file,
    args: plan.args,
    verbatim: plan.verbatim,
    cwd,
    env: { ...launchEnv, ...plan.env },
    parentPid,
    retainDescendantsOnSuccess,
    traceEnabled,
    ...jobs,
    ...(testFault && testFault !== 'drop-registered' ? { testFault } : {}),
    stdoutMarker,
    stderrMarker,
  })
  if (Buffer.byteLength(spec) > 1_048_576)
    return notStartedOwnedChild(new Error('owned launch specification too large'))
  let child: ChildProcess
  try {
    child = spawn(helperLaunch.file, helperLaunch.args, spawnOptions)
  } catch (failure) {
    // Node throws native spawn failures with syscall 'spawn', before returning a child.
    const error = failure as NodeJS.ErrnoException
    // With no AbortSignal and only fixed non-IPC stdio, synchronous validation
    // and native spawn errors happen before ChildProcess is published.
    if (error instanceof Error) return notStartedOwnedChild(failure)
    throw failure
  }
  const stopSignal = ownedStopSignal(helperOptions.killSignal)
  // Start at helper admission, not when authentication or Root startup finishes.
  let runtimeTimer = timeout ? setTimeout(onTimeout, timeout) : undefined
  function onTimeout() {
    clearRuntimeTimer()
    try {
      child.kill(stopSignal)
    } catch (error) {
      child.emit('error', error)
    }
  }
  function clearRuntimeTimer() {
    if (runtimeTimer) clearTimeout(runtimeTimer)
    runtimeTimer = undefined
  }
  if (retainDescendantsOnSuccess) {
    for (const [index, marker] of [stdoutMarker, stderrMarker].entries()) {
      const raw = index === 0 ? child.stdout : child.stderr
      if (!raw || typeof raw === 'string') continue
      const clean = completionStream(Buffer.from(marker))
      raw.on('error', (error) => {
        if (!clean.readableEnded) clean.destroy(error)
      })
      raw.once('close', () => {
        if (!raw.readableEnded && !clean.destroyed && !clean.readableEnded) {
          clean.destroy(new Error('managed output closed before completion'))
        }
      })
      raw.pipe(clean)
      if (index === 0) child.stdout = clean
      else child.stderr = clean
    }
  }
  let resolveCompletion!: (value: PrivateCompletion) => void
  let rawReject!: (error: Error) => void
  let resolveIdentity!: (value: Awaited<PrivateLaunch['identity']>) => void
  let rejectIdentity!: (error: Error) => void
  const identity: PrivateLaunch['identity'] = new Promise((resolve, reject) => {
    resolveIdentity = resolve
    rejectIdentity = reject
  })
  void identity.catch(() => undefined)
  const ownedCompletion = new Promise<PrivateCompletion>((resolve, reject) => {
    resolveCompletion = resolve
    rawReject = reject
  })
  void ownedCompletion.then(clearRuntimeTimer, clearRuntimeTimer)
  let stopped = false
  let handedOff = false
  let acknowledged = false
  let proofFailed = false
  let commandError: Error | null = null
  let helperLastPhase = 'helper-spawned'
  let rootPid: number | null = null
  let rootState = '-'
  const lease: RetainedOwnedProgramLease = {
    commit: (signal) => {
      const result = job.lease.commit(signal)
      void result.then(removeAbortListener, () => undefined)
      return result
    },
    revoke: () => {
      clearRuntimeTimer()
      removeAbortListener()
      return job.lease.revoke()
    },
  }
  const rejectCompletion = (error: Error) => {
    proofFailed = true
    if (job.authMayHaveBeenSent && (rootPid === null || stopped)) lease.revoke()
    const failure = new UnconfirmedOwnedProgramError(error, lease, commandError)
    rejectIdentity(failure)
    rawReject(failure)
  }
  const privateLaunch: PrivateLaunch = {
    lease,
    get resourceCleanup() {
      return retainDescendantsOnSuccess ? job.cleanup : undefined
    },
    identity,
    joinControlClose: () => transport.joinClose(),
    acknowledge: () => {
      if (acknowledged || !transport.acknowledge()) return false
      acknowledged = true
      return true
    },
    get stopped() {
      return stopped
    },
    diagnostics: () => ({
      helperLastPhase,
      helperStarted: spawned || child.pid !== undefined,
      rootStarted: rootPid !== null,
      helperPid: child.pid ?? null,
      rootPid,
      rootState,
    }),
  }
  launches.set(child, privateLaunch)
  const killHelper = (signal: NodeJS.Signals) => ChildProcess.prototype.kill.call(child, signal)
  let sawExit = false
  let spawnFailed = false
  child.once('exit', () => {
    sawExit = true
    clearRuntimeTimer()
  })
  const helperExited = () =>
    spawnFailed || sawExit || child.exitCode != null || child.signalCode != null
  async function joinProducer() {
    if (registrationFixture?.beforeJoin) await registrationFixture.beforeJoin()
    const controlClosed = transport.dispose(new Error('owned launch revoked before completion'))
    if (!helperExited() && child.pid !== undefined) {
      try {
        killHelper('SIGKILL')
      } catch {
        // The closed control pipe also stops the producer; only exit proves it.
      }
    }
    await Promise.all([controlClosed, joinHelperExit()])
  }
  function joinHelperExit() {
    if (helperExited()) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const onExit = () => {
        clearTimeout(timer)
        child.off('exit', onExit)
        child.off('error', onSpawnFailure)
        resolve()
      }
      const onSpawnFailure = () => {
        if (spawnFailed) onExit()
      }
      const timer = setTimeout(() => {
        child.off('exit', onExit)
        child.off('error', onSpawnFailure)
        reject(new Error('owned Job cannot certify drain before helper exit'))
      }, 5000).unref()
      child.once('exit', onExit)
      child.on('error', onSpawnFailure)
    })
  }
  child.once('close', clearRuntimeTimer)
  const pauseAuth = registrationFixture?.pauseAuth
  const transport = ownedControlTransport({
    pipe: controlPipe,
    child,
    launchId,
    secret,
    parentPid,
    mode: retainDescendantsOnSuccess ? 'retained' : 'ordinary',
    helperExited,
    killHelper,
    pauseAuthForTest:
      pauseAuth &&
      (({ helperPid, birth, parentBirth }) =>
        pauseAuth({ pid: helperPid, birth, parentBirth }, jobs)),
    dropRegisteredForTest: testFault === 'drop-registered',
    observe(event) {
      switch (event.type) {
        case 'hello':
          // Freeze the exact epoch before a write can reach the producer, even
          // if the write subsequently throws or the pipe loses its reply.
          if (retainDescendantsOnSuccess) job.bindForAuth(event.parentBirth)
          helperLastPhase = 'authenticated-hello'
          resolveIdentity({ pid: child.pid!, birth: event.birth, launchId })
          break
        case 'setup':
          if (event.mode === 'retained') {
            job.adopt(event) // Already owned if REGISTERED is lost.
            registrationFixture?.adopted?.(event)
          }
          helperLastPhase = 'setup-confirmed'
          break
        case 'root-created':
        case 'root-exit':
        case 'phase':
          rootPid = event.rootPid
          if (event.type === 'root-created') {
            helperLastPhase = 'after-suspended-root-creation'
            rootState = 'suspended'
          } else if (event.type === 'root-exit') {
            helperLastPhase = 'root-exit'
            rootState = String(event.rootExitCode)
          } else {
            helperLastPhase = event.phase
            rootState = event.state
          }
          break
        case 'ready':
          privateLaunch.onReady?.()
          break
        case 'output-failure':
          privateLaunch.onOutputFailure?.(event.error)
          child.stdout?.destroy(event.error)
          child.stderr?.destroy(event.error)
          break
        case 'failure':
          rejectCompletion(event.error)
          break
        case 'complete':
          if (event.value === 'handoff') {
            handedOff = true
            job.handedOff()
            if (stopped) lease.revoke()
          } else {
            removeAbortListener()
            // Start the single retained resource join before publishing physical
            // EMPTY, but do not make Job-zero proof depend on the broker.
            job.releaseEmpty()
          }
          resolveCompletion(event.value)
          break
      }
    },
  })
  let spawned = false
  child.once('spawn', () => (spawned = true))
  const onChildError = (error: NodeJS.ErrnoException) => {
    commandError ??= error
    if (error === expectedAbort) return
    if (
      !spawned &&
      error.syscall === `spawn ${helperLaunch.file}` &&
      ['EACCES', 'EAGAIN', 'EMFILE', 'ENFILE', 'ENOENT'].includes(error.code ?? '') &&
      transport.cancelBeforeSession()
    ) {
      // Node reports these definitive OS spawn failures asynchronously. An
      // arbitrary error (or a missing pid) cannot certify lack of a helper.
      spawnFailed = true
      rejectIdentity(error)
      resolveCompletion('not-started')
    } else transport.abort(error)
  }
  child.on('error', onChildError)
  Object.assign(child, { ownedCompletion })
  child.kill = (signal?: NodeJS.Signals | number): boolean => {
    if (signal === 0) return ChildProcess.prototype.kill.call(child, 0)
    if (!job.markStop()) return false
    clearRuntimeTimer()
    stopped = true
    if (handedOff || (proofFailed && job.authMayHaveBeenSent)) {
      lease.revoke()
      return true
    }
    return transport.stop(signal) || acknowledged
  }
  let expectedAbort: Error | undefined
  const onAbort = () => {
    expectedAbort ??= abortError(signal!)
    child.kill(stopSignal)
    child.emit('error', expectedAbort)
  }
  function removeAbortListener() {
    signal?.removeEventListener('abort', onAbort)
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  child.once('close', () => {
    if (!acknowledged) removeAbortListener()
  })
  if (signal?.aborted) process.nextTick(onAbort)
  child.stdin?.on('error', () => {
    // Stdin is not the control transcript. Request cooperative stop on the private channel.
    child.kill('SIGTERM')
  })
  child.stdin?.write(`${spec}\n`)
  const keepsStdinOpen =
    options.stdio === 'pipe' || (Array.isArray(options.stdio) && options.stdio[0] === 'pipe')
  if (!keepsStdinOpen) child.stdin?.end()
  transport.connect()
  return child as PrivateOwnedChild
}

function ownedStopSignal(signal: SpawnOptions['killSignal']) {
  if (signal === 0) return 0
  const configured = typeof signal === 'string' ? signal.toUpperCase() : signal
  for (const name of ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGQUIT'] as const) {
    if (
      configured === name ||
      (typeof configured === 'number' && configured === constants.signals[name])
    ) {
      return name
    }
  }
  // The Windows Job stops as a whole even for Node signals with no wire equivalent.
  return 'SIGTERM'
}

function abortError(signal: AbortSignal) {
  return Object.assign(new Error('The operation was aborted', { cause: signal.reason }), {
    name: 'AbortError',
    code: 'ABORT_ERR',
  })
}
