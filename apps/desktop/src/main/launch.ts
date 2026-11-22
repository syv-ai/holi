/**
 * Starting a program the way its file needs. On macOS and Linux that is the
 * file and its arguments, untouched. On Windows two things differ:
 *
 *  - npm installs a tool as a `.cmd` launcher, and Node refuses to start one
 *    directly (`spawn EINVAL`, thrown synchronously from `spawn`). Recognizable
 *    npm shims are bypassed to run their JS entrypoint; opaque batches use
 *    `cmd.exe` only when every argument is representable safely.
 *  - a bare name (`pnpm`, `python`) is not found by `spawn` unless it names an
 *    `.exe`, so it is looked up on `PATH` with `PATHEXT` first.
 *
 * Callers that start a program from a path they have already resolved
 * (`resolveBin`) get the same answer for an `.exe` as for anything else:
 * nothing changes for it.
 */
import {
  ChildProcess,
  execFile,
  spawn,
  type ExecFileException,
  type SpawnOptions,
} from 'node:child_process'
import { PassThrough } from 'node:stream'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { win32 } from 'node:path'
import { resolveBin, type Platform } from './bin'
import { ownedLaunchControl, spawnOwnedLaunch } from './owned-process-launch'
import type { PrivateCompletion } from './owned-process-completion'
import {
  observeWindowsOwnedProgram,
  OwnedProgramResourceCleanupError,
  UnconfirmedOwnedProgramError,
  type RetainedExecMetadata,
} from './owned-program-lifetime'
import { resolveBundledWindowsNode } from './windows-node-runtime'

/** What to hand `spawn`, `execFile` or node-pty. */
export interface Launch {
  file: string
  args: string[]
  /** Windows: `args` is already a `cmd.exe` command line, not to be quoted
   *  again (`windowsVerbatimArguments`). */
  verbatim: boolean
  /** Per-child environment additions required to run Electron as Node. */
  env?: NodeJS.ProcessEnv
}

const BATCH = /\.(cmd|bat)$/i

/** Only a complete npm node shim is transparent; a custom batch may do other work. */
function npmShimScript(file: string): string | null {
  try {
    const lines = readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    const entry = lines
      .pop()
      ?.match(
        /^endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%"\s+"%dp0%\\([^"\r\n]+)" %\*$/i,
      )
    const header = [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      'IF EXIST "%dp0%\\node.exe" (',
      'SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      'SET "_prog=node"',
      'SET PATHEXT=%PATHEXT:;.JS;=;%',
      ')',
    ]
    if (!entry || lines.join('\n').toLowerCase() !== header.join('\n').toLowerCase()) return null
    const script = join(dirname(file), ...entry[1]!.split(/[\\/]/))
    return statSync(script).isFile() ? script : null
  } catch {
    return null
  }
}

function comspec(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'COMSPEC')
  return (key !== undefined ? env[key] : undefined) ?? 'cmd.exe'
}

export interface LaunchOptions {
  platform?: Platform
  env?: NodeJS.ProcessEnv
  /** Tests inject the lookup of a bare name. */
  resolve?: (name: string, env: NodeJS.ProcessEnv) => string | null
  /** Tests may supply the optional Windows runtime without installing it. */
  bundledWindowsNode?: () => string | null
  /** Tests exercise Electron's fallback branch without importing Electron. */
  electronRuntime?: boolean
  /** Resolve relative Windows executables from the caller's working directory. */
  cwd?: string
}

/** A bare name: no folder in it, so only the `PATH` can say where it is. */
const isBare = (name: string): boolean => !/[\\/]/.test(name)

/**
 * What to run for `file` and `args`. Windows first resolves bare names and
 * bypasses recognizable npm JavaScript shims. Opaque batches use cmd.exe only
 * for arguments that can be represented without shell expansion.
 */
export function launchPlan(
  file: string,
  args: readonly string[],
  {
    platform = process.platform,
    env = process.env,
    resolve,
    bundledWindowsNode = resolveBundledWindowsNode,
    electronRuntime = process.versions.electron !== undefined,
    cwd = process.cwd(),
  }: LaunchOptions = {},
): Launch {
  if ([file, ...args].some((value) => value.includes('\0'))) {
    throw new Error('Program paths and arguments cannot contain NUL characters.')
  }
  if (platform !== 'win32') return { file, args: [...args], verbatim: false }
  const look = resolve ?? ((name, e) => resolveBin(name, e, { platform }))
  const target = isBare(file)
    ? (look(file, env) ?? file)
    : win32.isAbsolute(file)
      ? file
      : win32.resolve(cwd, file)
  if (!BATCH.test(target)) return { file: target, args: [...args], verbatim: false }

  // npm's generated .cmd launchers are only a command-shell wrapper around a
  // JavaScript entrypoint. Bypass the wrapper so Windows receives argv through
  // CreateProcess rather than cmd.exe's lossy second parse.
  const script = npmShimScript(target)
  if (script) {
    const colocatedNode = join(dirname(target), 'node.exe')
    const callerNode = look('node', env)
    const isFile = (path: string): boolean => {
      try {
        return statSync(path).isFile()
      } catch {
        return false
      }
    }
    const bundledNode = electronRuntime ? bundledWindowsNode() : null
    const node = isFile(colocatedNode)
      ? colocatedNode
      : callerNode && /\.(?:exe|com)$/i.test(callerNode)
        ? callerNode
        : electronRuntime
          ? bundledNode
          : process.execPath
    if (!node || (node === bundledNode && !isFile(node))) {
      throw new Error(
        'The bundled Windows Node runtime is missing. Reinstall Holi to use this interactive CLI.',
      )
    }
    const useElectron = node === process.execPath && electronRuntime
    return {
      file: node,
      args: [script, ...args],
      verbatim: false,
      ...(useElectron ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {}),
    }
  }

  // cmd.exe cannot represent arbitrary argv: % expansion happens even inside
  // quotes, delayed expansion can consume !, and line breaks are commands. Do
  // not silently alter these inputs or risk executing them as shell syntax.
  const unsafe = args.find((arg) => /[\x00-\x1f"%!^&|<>]/u.test(arg) || arg.endsWith('\\'))
  if (unsafe !== undefined || /[\x00-\x1f"%!^&|<>]/u.test(target)) {
    throw new Error(
      `Cannot pass this argument safely to batch file ${target}; install a Node-based CLI shim or use an executable instead.`,
    )
  }
  const quote = (value: string) => `"${value}"`
  const line = [quote(target), ...args.map(quote)].join(' ')
  if (line.length + 2 > 8191) {
    throw new Error(
      `Cannot pass this command to batch file ${target}: Windows cmd.exe command limit is 8191 characters.`,
    )
  }
  return { file: comspec(env), args: ['/d', '/s', '/c', `"${line}"`], verbatim: true }
}

/** A `Launch` as the single command-line string node-pty takes on Windows,
 *  where an array would be quoted a second time. */
export function commandLine(launch: Launch): string | string[] {
  return launch.verbatim ? launch.args.join(' ') : launch.args
}

/**
 * `spawn` through `launchPlan`. On Windows it never throws: a failure to
 * start (an argument Windows cannot carry, a `.cmd` Node refuses) arrives as
 * the `error` event every caller already handles, on the next tick, with the
 * streams ended, so the caller's `child.stdout.on(...)` lines run as they do
 * for a program that failed to start. Elsewhere `spawn`'s throw is left as it
 * is, which is what callers there have always handled.
 */
export function spawnProgram(
  file: string,
  args: readonly string[],
  options: SpawnOptions,
  launch: LaunchOptions = {},
): ChildProcess {
  let plan: Launch
  const platform = launch.platform ?? process.platform
  try {
    plan = launchPlan(file, args, {
      env: options.env ?? process.env,
      cwd: typeof options.cwd === 'string' ? options.cwd : process.cwd(),
      ...launch,
    })
  } catch (failure) {
    if (platform !== 'win32') throw failure
    return failedChild(failure)
  }
  try {
    return spawn(plan.file, plan.args, {
      ...options,
      ...(plan.env ? { env: { ...(options.env ?? process.env), ...plan.env } } : {}),
      // No console to share with a child that has none of its own: a
      // detached child on Windows would open a window for a console
      // grandchild (the `node` behind `claude.cmd`). Its tree is stopped by
      // `killTree` instead of by a group.
      ...(platform === 'win32' && options.detached ? { detached: false } : {}),
      ...(plan.verbatim ? { windowsVerbatimArguments: true } : {}),
      // A console program started by a GUI app opens a window of its own.
      ...(platform === 'win32' ? { windowsHide: true } : {}),
    })
  } catch (failure) {
    if (platform !== 'win32') throw failure
    return failedChild(failure)
  }
}

function failedChild(failure: unknown): ChildProcess {
  const child = new ChildProcess()
  const out = new PassThrough()
  const err = new PassThrough()
  const input = new PassThrough()
  // Callers may queue input before the asynchronous planning error arrives.
  input.on('error', () => undefined)
  child.stdin = input
  child.stdout = out
  child.stderr = err
  process.nextTick(() => {
    child.emit('error', failure)
    input.destroy()
    out.end()
    err.end()
    child.emit('close', null, null)
  })
  return child
}

/**
 * On Windows, join command status and actual output settlement with authenticated
 * native proof. Proof failure reports immediately without relinquishing cleanup.
 * Retained EMPTY also joins resource cleanup; HANDOFF carries a revocable lease
 * until its next owner commits.
 */
export function execProgram(
  file: string,
  args: readonly string[],
  options: {
    cwd?: string
    env: NodeJS.ProcessEnv
    timeoutMs: number
    maxBuffer: number
    encoding: BufferEncoding
    /** Only a successful Claude `--bg` launch may detach its descendants. */
    retainDescendantsOnSuccess?: boolean
  },
  done: (
    err: ExecFileException | null,
    stdout: string,
    stderr: string,
    ownership?: RetainedExecMetadata,
  ) => void,
  launch: LaunchOptions = {},
): ChildProcess {
  let plan: Launch
  try {
    plan = launchPlan(file, args, {
      env: options.env,
      cwd: options.cwd ?? process.cwd(),
      ...launch,
    })
  } catch (failure) {
    const error = failure as ExecFileException
    process.nextTick(() => done(error, '', '', { kind: 'settled' }))
    return new ChildProcess()
  }
  if ((launch.platform ?? process.platform) !== 'win32') {
    try {
      return execFile(
        plan.file,
        plan.args,
        {
          cwd: options.cwd,
          env: plan.env ? { ...options.env, ...plan.env } : options.env,
          maxBuffer: options.maxBuffer,
          encoding: options.encoding,
          windowsHide: true,
          timeout: options.timeoutMs,
        },
        (err, stdout, stderr) => done(err, stdout, stderr, { kind: 'settled' }),
      )
    } catch (error) {
      process.nextTick(() => done(error as ExecFileException, '', '', { kind: 'settled' }))
      return new ChildProcess()
    }
  }
  const retained = options.retainDescendantsOnSuccess === true
  const child = spawnOwnedLaunch(
    plan,
    { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] },
    process.pid,
    retained,
  )
  joinWindowsExec(child, options, retained, done)
  child.stdin?.end()
  return child
}

function joinWindowsExec(
  child: ChildProcess & { ownedCompletion?: Promise<PrivateCompletion> },
  options: { timeoutMs: number; encoding: BufferEncoding; maxBuffer: number },
  retained: boolean,
  done: (
    err: ExecFileException | null,
    out: string,
    errOut: string,
    ownership: RetainedExecMetadata,
  ) => void,
) {
  const control = ownedLaunchControl(child)
  const outputs = [
    { stream: child.stdout, chunks: [] as string[] },
    { stream: child.stderr, chunks: [] as string[] },
  ]
  const detach: (() => void)[] = []
  let size = 0
  let overflow = false
  let acknowledged = false
  let reported = false
  const timer = setTimeout(() => {
    observer.record(
      Object.assign(new Error(`timed out after ${options.timeoutMs} ms`), {
        code: 'ETIMEDOUT',
        killed: true,
        ...control?.diagnostics(),
      }),
    )
    stop()
  }, options.timeoutMs)

  function complete(error: Error | null, ownership: RetainedExecMetadata) {
    if (reported) return
    reported = true
    clearTimeout(timer)
    for (const remove of detach) remove()
    if (control) {
      control.onReady = undefined
      control.onOutputFailure = undefined
    }
    done(
      error as ExecFileException | null,
      outputs[0]!.chunks.join(''),
      outputs[1]!.chunks.join(''),
      ownership,
    )
  }
  function unconfirmed(failure: UnconfirmedOwnedProgramError) {
    const { cause } = failure
    const lease = failure.lease ?? control?.lease ?? { revoke: () => Promise.reject(cause) }
    complete(failure.commandError ?? failure, { kind: 'unconfirmed', cause, lease })
  }
  function stop() {
    if (reported) return
    try {
      child.kill('SIGKILL')
    } catch {
      // A stop request cannot substitute for proof, or replace the first error.
    }
  }
  function acknowledge() {
    if (!reported && !acknowledged) acknowledged = control?.acknowledge() === true
  }
  const handoff =
    retained && control
      ? {
          onOutputEnd: acknowledge,
          acknowledged: () => acknowledged,
          complete(error: Error | null) {
            if (!error && !control.stopped) {
              complete(null, { kind: 'settled', lease: control.lease })
              return
            }
            const first = error ?? new Error('owned handoff was stopped before commit')
            void control.lease.revoke().then(
              () => complete(first, { kind: 'settled' }),
              (failure: unknown) =>
                unconfirmed(
                  failure instanceof UnconfirmedOwnedProgramError
                    ? new UnconfirmedOwnedProgramError(
                        failure.cause,
                        failure.lease ?? control.lease,
                        first,
                      )
                    : new UnconfirmedOwnedProgramError(failure, control.lease, first),
                ),
            )
          },
        }
      : undefined
  const observer = observeWindowsOwnedProgram(
    child,
    ({ error, ownership }) => {
      if (!retained || ownership !== 'empty') {
        complete(error, { kind: 'settled' })
        return
      }
      // Status, output and Job zero are already known. The command deadline
      // cannot replace that result while the broker finishes closing resources.
      clearTimeout(timer)
      const cleanupFailed = (cause: unknown) => {
        const lease = control?.lease ?? { revoke: () => Promise.reject(cause) }
        complete(error ?? new OwnedProgramResourceCleanupError(cause, lease), {
          kind: 'unconfirmed',
          ownership,
          cause,
          lease,
        })
      }
      const cleanup = control?.resourceCleanup
      if (!cleanup) {
        cleanupFailed(new Error('Retained EMPTY has no resource cleanup receipt'))
        return
      }
      void cleanup.then(() => complete(error, { kind: 'settled' }), cleanupFailed)
    },
    unconfirmed,
    {
      statusError: ({ code, signal }) =>
        signal !== null || (code !== null && code !== 0)
          ? Object.assign(new Error(`command failed with ${signal ?? code}`), {
              code,
              signal,
              killed: signal !== null,
            })
          : null,
      requestStop: stop,
      lease: control?.lease,
      handoff,
    },
  )
  const onOutputFailure = (error: Error) => {
    observer.record(error)
    stop()
  }
  const onReady = () => {
    if (observer.canAcknowledge()) acknowledge()
  }
  if (control) {
    control.onReady = handoff ? onReady : undefined
    control.onOutputFailure = onOutputFailure
  }
  for (const { stream, chunks } of outputs) {
    if (!stream) continue
    stream.setEncoding(options.encoding)
    const collect = (chunk: string) => {
      if (overflow || !chunk.length) return
      // Exit and command errors do not end a pipe. Keep the buffered tail, up
      // to the same limit, while the join waits for actual output settlement.
      size += Math.max(1, Buffer.byteLength(chunk, options.encoding))
      if (size <= options.maxBuffer) chunks.push(chunk)
      else {
        overflow = true
        onOutputFailure(
          Object.assign(new Error('maxBuffer exceeded'), {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          }),
        )
      }
    }
    stream.on('data', collect)
    detach.push(() => stream.off('data', collect))
  }
  if (handoff) onReady()
}
