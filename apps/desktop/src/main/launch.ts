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
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { win32 } from 'node:path'
import { resolveBin, type Platform } from './bin'
import { killTree } from './process-group'

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

/** Resolve only the recognizable npm-generated node_modules shim shape. */
function npmShimScript(file: string): string | null {
  try {
    const source = readFileSync(file, 'utf8')
    if (!/@echo\s+off/i.test(source) || !/%\*/.test(source)) return null
    // npm's Windows shim selects a colocated node.exe when present and points
    // it at a node_modules JavaScript package entrypoint. Requiring both
    // signatures avoids treating arbitrary batch programs as transparent.
    if (!/%(?:~dp0|dp0%)[\\/]node\.exe/i.test(source) || !/node_modules[\\/]/i.test(source))
      return null
    const match = source.match(/"%(?:~dp0|dp0%)[\\/]([^"\r\n]+\.js)"\s+%\*/i)
    const relativeScript = match?.[1]
    if (!relativeScript) return null
    const script = join(dirname(file), ...relativeScript.split(/[\\/]/))
    return existsSync(script) ? script : null
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
}

/** A bare name: no folder in it, so only the `PATH` can say where it is. */
const isBare = (name: string): boolean => !/[\\/]/.test(name) && win32.extname(name) === ''

/**
 * What to run for `file` and `args`. Windows first resolves bare names and
 * bypasses recognizable npm JavaScript shims. Opaque batches use cmd.exe only
 * for arguments that can be represented without shell expansion.
 */
export function launchPlan(
  file: string,
  args: readonly string[],
  { platform = process.platform, env = process.env, resolve }: LaunchOptions = {},
): Launch {
  if (platform !== 'win32') return { file, args: [...args], verbatim: false }
  const look = resolve ?? ((name, e) => resolveBin(name, e, { platform }))
  const target = isBare(file) ? (look(file, env) ?? file) : file
  if (!BATCH.test(target)) return { file: target, args: [...args], verbatim: false }

  // npm's generated .cmd launchers are only a command-shell wrapper around a
  // JavaScript entrypoint. Bypass the wrapper so Windows receives argv through
  // CreateProcess rather than cmd.exe's lossy second parse.
  const script = npmShimScript(target)
  if (script) {
    const colocatedNode = join(dirname(target), 'node.exe')
    const callerNode = look('node', env)
    const electronIsNode = /(?:^|[\\/])electron(?:\.exe)?$/i.test(process.execPath)
    const node = existsSync(colocatedNode) ? colocatedNode : callerNode ?? process.execPath
    const useElectron = node === process.execPath && electronIsNode
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
  const unsafe = args.find((arg) => /[\r\n\0]|[%!^&|<>]/u.test(arg))
  if (unsafe !== undefined || /[%!^&|<>\r\n]/u.test(target)) {
    throw new Error(
      `Cannot pass this argument safely to batch file ${target}; install a Node-based CLI shim or use an executable instead.`,
    )
  }
  const quote = (value: string) => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
  const line = [quote(target), ...args.map(quote)].join(' ')
  if (line.length > 8191) {
    throw new Error(`Cannot pass this command to batch file ${target}: Windows cmd.exe command limit is 8191 characters.`)
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
    plan = launchPlan(file, args, { env: options.env ?? process.env, ...launch })
  } catch (failure) {
    if (platform !== 'win32') throw failure
    const child = new ChildProcess()
    const out = new PassThrough()
    const err = new PassThrough()
    child.stdout = out
    child.stderr = err
    child.stdin = new PassThrough()
    out.end()
    err.end()
    process.nextTick(() => child.emit('error', failure))
    return child
  }
  try {
    return spawn(plan.file, plan.args, {
      ...options,
      ...(plan.env ? { env: { ...process.env, ...options.env, ...plan.env } } : {}),
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
    const child = new ChildProcess()
    const out = new PassThrough()
    const err = new PassThrough()
    child.stdout = out
    child.stderr = err
    child.stdin = new PassThrough()
    out.end()
    err.end()
    process.nextTick(() => child.emit('error', failure))
    return child
  }
}

/**
 * `execFile` through `launchPlan`. A program run through `cmd.exe` is not
 * stopped by `execFile`'s `timeout`, which ends `cmd.exe` and leaves the
 * `node` behind a `.cmd` running, and a `taskkill /T` sent after that finds no
 * root. So there the timeout is Holi's own and stops the whole tree while the
 * root is alive; everywhere else it is `execFile`'s, unchanged.
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
  },
  done: (err: ExecFileException | null, stdout: string, stderr: string) => void,
  launch: LaunchOptions = {},
): ChildProcess {
  let plan: Launch
  try {
    plan = launchPlan(file, args, { env: options.env, ...launch })
  } catch (failure) {
    const error = failure as ExecFileException
    process.nextTick(() => done(error, '', ''))
    return new ChildProcess()
  }
  const own = plan.verbatim
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
      ...(own ? { windowsVerbatimArguments: true } : { timeout: options.timeoutMs }),
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
    own && child.pid !== undefined
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
