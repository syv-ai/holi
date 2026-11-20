import { ChildProcess, type SpawnOptions } from 'node:child_process'
import { constants } from 'node:os'
import { getSystemErrorName } from 'node:util'
import { PassThrough, Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { launchPlan, spawnProgram } from './launch'
import { spawnOwnedLaunch } from './owned-process-launch'
import type { ProcessGroupSupervision } from './owned-process-supervision'
import { preparePosixSpawn } from './posix-launch-lease'

export const ownedProcessDrain = Symbol('ownedProcessDrain')

type SupervisedChild = ChildProcess & { [ownedProcessDrain]?: ProcessGroupSupervision }

/** Start a Windows job or, by default on POSIX, an ordinary detached child.
 * Only owners that join physical drainage opt into `posixGroupLease`.
 */
export function spawnOwnedProgram(
  bin: string,
  args: readonly string[],
  options: SpawnOptions & { posixGroupLease?: boolean },
  parentPid = process.pid,
): SupervisedChild {
  if (process.platform !== 'win32') {
    const { posixGroupLease, ...spawnOptions } = options
    if (!posixGroupLease) return spawnProgram(bin, args, { ...spawnOptions, detached: true })
    return spawnLeased(bin, args, spawnOptions)
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
    const failed = new ChildProcess()
    const input = new PassThrough()
    const output = new PassThrough()
    const errors = new PassThrough()
    input.on('error', () => undefined)
    failed.stdin = input
    failed.stdout = output
    failed.stderr = errors
    process.nextTick(() => {
      failed.emit('error', failure as Error)
      input.destroy()
      output.end()
      errors.end()
      failed.emit('close', null, null)
    })
    return failed
  }
  return spawnOwnedLaunch(plan, options, parentPid)
}

type Stdio = NonNullable<Exclude<SpawnOptions['stdio'], string>>

function optionError(code: string, field: string, expected: string): never {
  throw Object.assign(new TypeError(`Invalid ${field}: ${expected}.`), { code })
}

function leasedStdio(options: SpawnOptions): Stdio {
  // Validate the caller values *before* replacing them with helper values.
  // Keep Node's validation for untouched fields too; a throw from the actual
  // spawn call is never classified by the exception class or code alone.
  const { detached, argv0, shell, cwd } = options
  if (detached != null && typeof detached !== 'boolean')
    optionError('ERR_INVALID_ARG_TYPE', 'options.detached', 'expected a boolean')
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

  // Insert private descriptors after every caller slot, including IPC.
  const value = options.stdio || 'pipe'
  if (!Array.isArray(value) && !['pipe', 'overlapped', 'ignore', 'inherit'].includes(value))
    optionError('ERR_INVALID_ARG_VALUE', 'stdio', 'expected a stdio shortcut or array')
  const stdio: Stdio = Array.isArray(value) ? [...value] : [value, value, value]
  while (stdio.length < 3) stdio.push('pipe')
  return stdio
}

function spawnLeased(bin: string, args: readonly string[], options: SpawnOptions): SupervisedChild {
  const stdio = leasedStdio(options)
  const { file, args: argv } = launchPlan(bin, args)
  const command = options.shell
    ? typeof options.shell === 'string'
      ? options.shell
      : '/bin/sh'
    : file
  const commandArgs = options.shell ? ['-c', [file, ...argv].join(' ')] : argv
  const launch = preparePosixSpawn(command, commandArgs, options, stdio)
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
        launch
          .cancel(error.code === 'ENOENT' ? 'unlaunched' : 'possibly-launched')
          .then(resolve, reject)
      })
    })
    void cleanup.catch(() => {})
    child[ownedProcessDrain] = { drain: () => cleanup }
    return child
  }
  const binding = launch.bind(child.pid)
  child[ownedProcessDrain] = { drain: launch.drain }
  adaptExecEvents(child, launch, binding)
  child.kill = (signal = 'SIGTERM') => {
    const number =
      typeof signal === 'number'
        ? signal
        : constants.signals[signal.toUpperCase() as NodeJS.Signals]
    if (number === undefined)
      throw Object.assign(new TypeError('Unknown signal: ' + signal), {
        code: 'ERR_UNKNOWN_SIGNAL',
      })
    if (child.exitCode !== null || child.signalCode !== null) return false
    if (!launch.signal(number)) return false
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
  let state: 'pending' | 'spawned' | 'failed' = 'pending'
  let reportedFailure = false
  let failureCode: number | undefined
  // At most one native notification of each kind can be pending.
  const lifecycle: Array<{ event: 'exit' | 'close' | 'disconnect'; args: unknown[] }> = []
  const restorePipes: Array<() => void> = []

  function fail(error: unknown, errno?: number) {
    if (state !== 'pending') return
    state = 'failed'
    failureCode = errno
    const cleanup = errno === undefined ? launch.failExecution(error) : launch.drain()
    void cleanup.catch(() => {})
    // Return normally to Node's onexit/onread, including its native close
    // accounting. Notify the consumer before forwarding a pending close.
    process.nextTick(() => {
      emit('error', error)
      reportedFailure = true
      flushLifecycle()
    })
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
    flushLifecycle()
  }

  function probe(providerIO: boolean) {
    if (state !== 'pending') return
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
