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
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { win32 } from 'node:path'
import { resolveBin, type Platform } from './bin'
import { killTree } from './process-group'
import { spawnOwnedLaunch } from './owned-process-launch'

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

/** Resolve the optional runtime without making it a requirement on other OSes. */
function resolveBundledWindowsNode(): string | null {
  try {
    const moduleRequire = typeof require === 'function' ? require : createRequire(import.meta.url)
    const file = moduleRequire.resolve('node-win-x64/bin/node.exe')
    return file.replace(
      /(.*[\\/])resources([\\/])app\.asar([\\/])/i,
      '$1resources$2app.asar.unpacked$3',
    )
  } catch {
    return null
  }
}

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
 * `execFile` through `launchPlan`. On Windows its own timeout would end only
 * the root, leaving descendants without a live root for `taskkill /T` to find.
 * Holi's timer stops the tree before the root exits, for executables and batch
 * launchers alike. Successful background launches keep their descendants.
 * POSIX keeps `execFile`'s timeout unchanged.
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
  done: (err: ExecFileException | null, stdout: string, stderr: string) => void,
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
    process.nextTick(() => done(error, '', ''))
    return new ChildProcess()
  }
  const ownTimeout = (launch.platform ?? process.platform) === 'win32'
  if (ownTimeout) {
    const child = spawnOwnedLaunch(
      plan,
      {
        cwd: options.cwd,
        env: plan.env ? { ...options.env, ...plan.env } : options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        ...(plan.verbatim ? { windowsVerbatimArguments: true } : {}),
      },
      process.pid,
      options.retainDescendantsOnSuccess ?? false,
    )
    let stdout = ''
    let stderr = ''
    let failure: ExecFileException | null = null
    let completed = false
    let committedSuccess = false
    let stdoutEnded = false
    let stderrEnded = false
    const ownedControl = child as ChildProcess & {
      ownedSuccessReady?: () => boolean
      acknowledgeOwnedSuccess?: () => boolean
    }
    const acknowledge = ownedControl.acknowledgeOwnedSuccess
    const timer = setTimeout(() => {
      if (committedSuccess) return
      failure = Object.assign(new Error(`timed out after ${options.timeoutMs} ms`), {
        killed: true,
        code: 'ETIMEDOUT',
      }) as ExecFileException
      child.kill('SIGKILL')
    }, options.timeoutMs)
    const append = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
      if (failure) return
      const text = Buffer.isBuffer(chunk) ? chunk.toString(options.encoding) : chunk
      if (target === 'stdout') stdout += text
      else stderr += text
      if (
        !failure &&
        Buffer.byteLength(stdout, options.encoding) + Buffer.byteLength(stderr, options.encoding) >
          options.maxBuffer
      ) {
        failure = Object.assign(new Error('maxBuffer exceeded'), {
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        }) as ExecFileException
        child.kill('SIGKILL')
      }
    }
    child.stdout?.setEncoding(options.encoding)
    child.stderr?.setEncoding(options.encoding)
    child.stdout?.on('data', (chunk: Buffer | string) => append('stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer | string) => append('stderr', chunk))
    let readinessPoll: NodeJS.Timeout | undefined
    const maybeAcknowledge = () => {
      if (
        committedSuccess ||
        failure ||
        !stdoutEnded ||
        !stderrEnded ||
        !acknowledge ||
        !ownedControl.ownedSuccessReady?.()
      ) {
        return
      }
      try {
        if (!acknowledge()) throw new Error('managed launch success acknowledgement was rejected')
        committedSuccess = true
        clearTimeout(timer)
        if (readinessPoll) clearInterval(readinessPoll)
      } catch (error) {
        failure = error as ExecFileException
        child.kill('SIGKILL')
      }
    }
    child.stdout?.once('end', () => {
      stdoutEnded = true
      maybeAcknowledge()
    })
    child.stderr?.once('end', () => {
      stderrEnded = true
      maybeAcknowledge()
    })
    if (acknowledge) readinessPoll = setInterval(maybeAcknowledge, 10)
    const stopOnStreamError = (error: Error) => {
      failure ??= error as ExecFileException
      child.kill('SIGKILL')
    }
    child.stdout?.on('error', stopOnStreamError)
    child.stderr?.on('error', stopOnStreamError)
    child.stdin?.on('error', (error) => {
      failure ??= error as ExecFileException
      child.kill('SIGKILL')
    })
    child.on('error', (error) => {
      failure ??= error as ExecFileException
    })
    child.on('close', (code, signal) => {
      if (completed) return
      completed = true
      clearTimeout(timer)
      if (readinessPoll) clearInterval(readinessPoll)
      if (!failure && (code !== 0 || signal !== null)) {
        failure = Object.assign(new Error(`command failed with ${signal ?? code}`), {
          code,
          signal,
          killed: signal !== null,
        }) as ExecFileException
      }
      done(failure, stdout, stderr)
    })
    child.stdin?.end()
    return child
  }
  let timedOut = false
  const child = execFile(
    plan.file,
    plan.args,
    {
      cwd: options.cwd,
      env: plan.env ? { ...options.env, ...plan.env } : options.env,
      maxBuffer: options.maxBuffer,
      encoding: options.encoding,
      windowsHide: true,
      ...(plan.verbatim ? { windowsVerbatimArguments: true } : {}),
      ...(!ownTimeout ? { timeout: options.timeoutMs } : {}),
    },
    (err, stdout, stderr) => {
      if (timer !== undefined) clearTimeout(timer)
      done(
        timedOut
          ? (Object.assign(new Error(`timed out after ${options.timeoutMs} ms`), {
              killed: true,
            }) as ExecFileException)
          : err,
        stdout,
        stderr,
      )
    },
  )
  const timer =
    ownTimeout && child.pid !== undefined
      ? setTimeout(() => {
          timedOut = true
          // `execFile`'s own timeout also closes the pipes, which is what makes
          // its callback fire when a descendant (a `--bg` supervisor) still
          // holds them: so they are closed here too.
          child.stdout?.destroy()
          child.stderr?.destroy()
          // A root that has exited may have a pid that is another program's
          // now: its tree is not stopped by pid.
          if (child.exitCode !== null || child.signalCode !== null) return
          killTree(child.pid!, 'SIGKILL', 'win32')
        }, options.timeoutMs)
      : undefined
  return child
}
