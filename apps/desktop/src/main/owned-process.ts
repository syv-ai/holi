import { ChildProcess, type SpawnOptions } from 'node:child_process'
import { constants } from 'node:os'
import { getSystemErrorName } from 'node:util'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { launchPlan, spawnProgram } from './launch'
import { notStartedOwnedChild, spawnOwnedLaunch } from './owned-process-launch'
import type { ProcessGroupSupervision } from './owned-process-supervision'
import { preparePosixSpawn, refusePosixSpawnPreparation } from './posix-launch-lease'
import { markPosixNonAdmission, posixLaunchNonAdmission } from './posix-ownership-journal'

import type { ManagedOwnedChild } from './owned-program-lifetime'

export const ownedProcessDrain = Symbol('ownedProcessDrain')

type SupervisedChild = ManagedOwnedChild & { [ownedProcessDrain]?: ProcessGroupSupervision }

/** Start a Windows job or, by default on POSIX, an ordinary detached child.
 * Only owners that join physical drainage opt into `posixGroupLease`.
 */
export function spawnOwnedProgram(
  bin: string,
  args: readonly string[],
  options: SpawnOptions & { posixGroupLease?: boolean; ownershipRecordPath?: string },
  parentPid = process.pid,
): SupervisedChild {
  if (process.platform !== 'win32') {
    const { posixGroupLease, ownershipRecordPath, ...spawnOptions } = options
    if (!posixGroupLease) return spawnProgram(bin, args, { ...spawnOptions, detached: true })
    return spawnLeased(bin, args, spawnOptions, ownershipRecordPath)
  }
  const launchEnv = { ...(options.env ?? process.env) }
  const planningEnv = { ...launchEnv }
  for (const key of Object.keys(planningEnv)) {
    if (key.toUpperCase() === 'HOLI_OWNED_PROCESS_TRACE') delete planningEnv[key]
  }
  let plan
  try {
    plan = launchPlan(bin, args, {
      env: planningEnv,
      platform: 'win32',
      cwd: typeof options.cwd === 'string' ? options.cwd : process.cwd(),
    })
  } catch (failure) {
    return notStartedOwnedChild(failure)
  }
  return spawnOwnedLaunch(plan, options, parentPid)
}

type Stdio = NonNullable<Exclude<SpawnOptions['stdio'], string>>

function optionError(code: string, field: string, expected: string): never {
  const ErrorType = code === 'ERR_OUT_OF_RANGE' ? RangeError : TypeError
  throw Object.assign(new ErrorType(`Invalid ${field}: ${expected}.`), { code })
}

function validateSpawnOptions(options: SpawnOptions): Stdio {
  // Mirror Node's pre-native option checks before constructing a private lease.
  // Actual spawn still validates; nothing that throws there is presumed safe.
  const { argv0, shell, cwd, signal, timeout, killSignal, serialization } = options
  for (const key of ['detached', 'windowsHide', 'windowsVerbatimArguments'] as const) {
    if (options[key] != null && typeof options[key] !== 'boolean')
      optionError('ERR_INVALID_ARG_TYPE', `options.${key}`, 'expected a boolean')
  }
  for (const key of ['uid', 'gid'] as const) {
    const value = options[key]
    if (value != null && (typeof value !== 'number' || (value | 0) !== value))
      optionError('ERR_INVALID_ARG_TYPE', `options.${key}`, 'expected an int32')
  }
  if (shell != null && typeof shell !== 'boolean' && typeof shell !== 'string')
    optionError('ERR_INVALID_ARG_TYPE', 'options.shell', 'expected a boolean or string')
  if (argv0 != null && typeof argv0 !== 'string')
    optionError('ERR_INVALID_ARG_TYPE', 'options.argv0', 'expected a string')
  if (argv0?.includes('\0')) optionError('ERR_INVALID_ARG_VALUE', 'options.argv0', 'unexpected NUL')
  if (typeof shell === 'string' && shell.includes('\0'))
    optionError('ERR_INVALID_ARG_VALUE', 'options.shell', 'unexpected NUL')
  const path = cwd instanceof URL ? fileURLToPath(cwd) : cwd
  if (
    (typeof path === 'string' && path.includes('\0')) ||
    (path instanceof Uint8Array && path.includes(0))
  )
    optionError('ERR_INVALID_ARG_VALUE', 'options.cwd', 'unexpected NUL')
  if (path != null && typeof path !== 'string' && !(path instanceof Uint8Array))
    optionError('ERR_INVALID_ARG_TYPE', 'options.cwd', 'expected a string, Buffer or URL')

  if (timeout != null && (!Number.isInteger(timeout) || timeout < 0))
    optionError('ERR_OUT_OF_RANGE', 'timeout', 'expected an unsigned integer')
  if (
    signal !== undefined &&
    (signal === null || typeof signal !== 'object' || !('aborted' in signal))
  )
    optionError('ERR_INVALID_ARG_TYPE', 'options.signal', 'expected an AbortSignal')
  if (killSignal != null) {
    if (typeof killSignal !== 'number' && typeof killSignal !== 'string')
      optionError('ERR_INVALID_ARG_TYPE', 'options.killSignal', 'expected a string or number')
    const signals = constants.signals
    if (
      !(typeof killSignal === 'number'
        ? Object.values(signals).includes(killSignal)
        : Object.hasOwn(signals, killSignal.toUpperCase()))
    )
      optionError('ERR_UNKNOWN_SIGNAL', 'options.killSignal', 'unknown signal')
  }
  if (serialization !== undefined && serialization !== 'json' && serialization !== 'advanced')
    optionError('ERR_INVALID_ARG_VALUE', 'options.serialization', 'expected json or advanced')

  // Insert private descriptors after every caller slot, including IPC.
  const value = options.stdio || 'pipe'
  if (!Array.isArray(value) && !['pipe', 'overlapped', 'ignore', 'inherit'].includes(value))
    optionError('ERR_INVALID_ARG_VALUE', 'stdio', 'expected a stdio shortcut or array')
  const stdio: Stdio = Array.isArray(value) ? [...value] : [value, value, value]
  while (stdio.length < 3) stdio.push('pipe')
  let ipc = false
  for (const entry of stdio) {
    if (entry === 'ipc') {
      if (ipc) optionError('ERR_IPC_ONE_PIPE', 'stdio', 'only one IPC descriptor is allowed')
      ipc = true
      continue
    }
    if (
      entry == null ||
      typeof entry === 'number' ||
      ['pipe', 'overlapped', 'ignore', 'inherit'].some((mode) => mode === entry)
    )
      continue
    const stream = entry as { fd?: number; handle?: unknown; _handle?: unknown }
    if (typeof stream.fd === 'number') continue
    // Native stream handles still go through Node's own instance validation.
    if (
      [entry, stream.handle, stream._handle].some((handle) =>
        /^(Pipe|TTY|TCP|UDP)$/.test(handle?.constructor?.name ?? ''),
      )
    )
      continue
    optionError(
      typeof entry === 'string' || ArrayBuffer.isView(entry)
        ? 'ERR_INVALID_SYNC_FORK_INPUT'
        : 'ERR_INVALID_ARG_VALUE',
      'stdio',
      'invalid descriptor',
    )
  }
  return stdio
}

function spawnLeased(
  bin: string,
  args: readonly string[],
  options: SpawnOptions,
  ownershipRecordPath: string | undefined,
): SupervisedChild {
  let command: string
  let commandArgs: string[]
  let stdio: Stdio
  try {
    stdio = validateSpawnOptions(options)
    if (typeof bin !== 'string') optionError('ERR_INVALID_ARG_TYPE', 'file', 'expected a string')
    if (!bin) optionError('ERR_INVALID_ARG_VALUE', 'file', 'cannot be empty')
    const { file, args: argv } = launchPlan(bin, args)
    command = options.shell ? (typeof options.shell === 'string' ? options.shell : '/bin/sh') : file
    commandArgs = options.shell ? ['-c', [file, ...argv].join(' ')] : argv
  } catch (error) {
    refusePosixSpawnPreparation(ownershipRecordPath, error)
  }
  const launch = preparePosixSpawn(command, commandArgs, { ...options, ownershipRecordPath }, stdio)
  let child: SupervisedChild
  try {
    child = spawnProgram(launch.executable, launch.args, launch.options)
  } catch (error) {
    // uv_spawn can register a real child before parent-side stream setup
    // fails. Close admission, but retain the channel and join actual proof.
    const cleanup = launch.cancel('possibly-launched')
    void cleanup.catch(() => {})
    if (
      error instanceof Error &&
      Object.isExtensible(error) &&
      Object.getOwnPropertyDescriptor(error, 'cleanup')?.configurable !== false
    ) {
      Object.defineProperty(error, 'cleanup', { value: cleanup, configurable: true })
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    throw Object.assign(new Error(message, { cause: error }), { cleanup })
  }
  if (child.stdio) (child.stdio as unknown[]).length = stdio.length
  Object.assign(child, {
    spawnfile: command,
    spawnargs: [options.argv0 ?? command, ...commandArgs],
  })
  if (child.pid === undefined) {
    // An asynchronous native ENOENT without a PID means the helper could
    // not exec (e.g. a missing cwd). Other native outcomes are ambiguous.
    const cleanup = new Promise<void>((resolve, reject) => {
      child.prependOnceListener('error', (error: NodeJS.ErrnoException) => {
        // This is Node's no-PID asynchronous exec outcome, not a caught
        // exception from invoking spawn.
        const unlaunched = error.code === 'ENOENT'
        if (unlaunched) markPosixNonAdmission(error, cleanup)
        launch.cancel(unlaunched ? 'unlaunched' : 'possibly-launched').then(resolve, reject)
      })
    })
    void cleanup.catch(() => {})
    child[ownedProcessDrain] = { drain: () => cleanup }
    return child
  }
  const binding = launch.bind(child.pid)
  child[ownedProcessDrain] = { drain: launch.drain }
  adaptExecEvents(child, launch, binding)
  // Node reports an already-aborted signal on nextTick. Close the gate now;
  // startup continuations may run before that tick when called in a microtask.
  if (options.signal?.aborted) launch.stopBeforeCommit()
  let abortKillAcknowledged = false
  // Node routes both its spawn timeout and AbortSignal through child.kill.
  child.kill = (signal = 'SIGTERM') => {
    const number =
      typeof signal === 'number'
        ? signal
        : constants.signals[signal.toUpperCase() as NodeJS.Signals]
    if (number === undefined)
      throw Object.assign(new TypeError('Unknown signal: ' + signal), {
        code: 'ERR_UNKNOWN_SIGNAL',
      })
    const preCommitAbort =
      number !== 0 && options.signal?.aborted && !abortKillAcknowledged && launch.stopBeforeCommit()
    if (preCommitAbort) abortKillAcknowledged = true
    else {
      if (child.exitCode !== null || child.signalCode !== null) return false
      if (!launch.signal(number)) return false
    }
    Object.assign(child, { killed: true })
    return true
  }
  return child
}

// Keep the actual Node pipes (including extra fds), channel, flow control and
// native close accounting. Admission of a provider byte/message is synchronous:
// the helper never sends either, and GO and exec CLOEXEC precede provider I/O.
function adaptExecEvents(
  child: ChildProcess,
  launch: ReturnType<typeof preparePosixSpawn>,
  binding: Promise<ProcessGroupSupervision>,
) {
  const emit = child.emit.bind(child)
  // Node registers its timeout/abort disposers before spawn returns, on the
  // native child's exit. A pre-GO stop hides that exit from provider observers
  // but must still release Node's own resources.
  const nativeExitListeners = child.rawListeners('exit')
  let state: 'pending' | 'spawned' | 'failed' = 'pending'
  let reportedFailure = false
  let failureCode: number | undefined
  let abortError: unknown
  // At most one native notification of each kind can be pending.
  const lifecycle: Array<{ event: 'exit' | 'close' | 'disconnect'; args: unknown[] }> = []
  const restorePipes: Array<() => void> = []

  function fail(error: unknown, errno?: number) {
    if (state !== 'pending') return
    state = 'failed'
    failureCode = errno
    if (launch.canceledBeforeCommit()) {
      // Only substitute Node's AbortError for a proven pre-admission stop,
      // never for a real startup or cleanup failure.
      const refusal = posixLaunchNonAdmission(error)
      if (refusal && abortError !== undefined) {
        markPosixNonAdmission(abortError, refusal.cleanup)
        error = abortError
      }
    } else {
      const cleanup = errno === undefined ? launch.failExecution(error) : launch.drain()
      void cleanup.catch(() => {})
      error = abortError ?? error
    }
    // Return normally to Node's onexit/onread, including its native close
    // accounting. Notify the consumer before forwarding a pending close.
    process.nextTick(() => reportFailure(error))
  }

  function reportFailure(error: unknown) {
    if (reportedFailure) return false
    reportedFailure = true
    const reported = emit('error', error)
    flushLifecycle()
    return reported
  }

  function emitLifecycle(event: 'exit' | 'close' | 'disconnect', args: unknown[]) {
    if (event === 'exit' && state === 'failed') return false
    if (event === 'close' && failureCode !== undefined) return emit('close', failureCode, null)
    return emit(event, ...args)
  }

  function flushLifecycle() {
    for (const { event, args } of lifecycle.splice(0)) emitLifecycle(event, args)
  }

  function confirm(result: number | null) {
    if (state !== 'pending') return
    if (result !== null) {
      const code = getSystemErrorName(result)
      const syscall = 'spawn ' + child.spawnfile
      Object.assign(child, { exitCode: result })
      fail(
        Object.assign(new Error(syscall + ' ' + code), {
          errno: result,
          code,
          syscall,
          path: child.spawnfile,
          spawnargs: child.spawnargs.slice(1),
        }),
        result,
      )
      return
    }
    state = 'spawned'
    for (const restore of restorePipes) restore()
    emit('spawn')
    if (abortError !== undefined) emit('error', abortError)
    flushLifecycle()
  }

  function probe(providerIO: boolean) {
    if (state !== 'pending' || launch.canceledBeforeCommit()) return
    let result: number | null | undefined
    try {
      result = launch.execution()
      if (providerIO && result === undefined)
        throw new Error('POSIX provider I/O arrived without an exec receipt.')
    } catch (error) {
      fail(error)
      return
    }
    // Do not mistake an exception from a user listener for a receipt fault.
    if (result !== undefined) confirm(result)
  }

  for (const pipe of child.stdio) {
    if (!(pipe instanceof Readable) || !pipe.readable) continue
    const push = pipe.push
    restorePipes.push(() => {
      pipe.push = push
    })
    pipe.push = function (chunk, encoding) {
      if (chunk !== null) {
        probe(true)
        if (state !== 'spawned') return true // No bytes from a failed launch escape.
      }
      return push.call(this, chunk, encoding)
    }
  }
  child.emit = (event: string | symbol, ...args: unknown[]) => {
    if (event === 'spawn') return false
    if (event === 'error' && (args[0] as NodeJS.ErrnoException)?.code === 'ABORT_ERR') {
      if (launch.canceledBeforeCommit()) {
        // Keep Node's AbortError (including its cause), but report it only
        // once the no-admission path has proved physical cleanup.
        abortError ??= args[0]
        return false
      }
      if (state !== 'spawned') {
        // GO was written. A delayed ACK may still precede a successful exec.
        // Don't let a post-admission AbortError reorder synthetic spawn.
        abortError ??= args[0]
        return false
      }
    }
    if (event === 'message') {
      probe(true)
      if (state !== 'spawned') {
        // An IPC message can transfer a handle even if admission failed.
        const handle = args[1] as { destroy?: () => void; close?: () => void } | undefined
        if (handle?.destroy) handle.destroy()
        else handle?.close?.()
        return false
      }
    } else if (event === 'exit' || event === 'close' || event === 'disconnect') {
      if (event === 'exit') {
        const listeners = nativeExitListeners.splice(0)
        if (launch.canceledBeforeCommit()) {
          const remaining = child.rawListeners('exit')
          for (const listener of listeners) {
            if (remaining.includes(listener)) Reflect.apply(listener, child, args)
          }
          return false
        }
      }
      probe(false)
      if (state === 'pending' || (state === 'failed' && !reportedFailure)) {
        lifecycle.push({ event, args })
        return false
      }
      return emitLifecycle(event, args)
    }
    return emit(event, ...args)
  }
  void binding
    .then(() => launch.waitForExecution())
    .then(
      (result) => process.nextTick(() => confirm(result)),
      (error: unknown) => fail(error),
    )
}
