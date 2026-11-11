/**
 * Starting a program the way its file needs. On macOS and Linux that is the
 * file and its arguments, untouched. On Windows two things differ:
 *
 *  - npm installs a tool as a `.cmd` launcher, and Node refuses to start one
 *    directly (`spawn EINVAL`, thrown synchronously from `spawn`). It runs
 *    through `cmd.exe /d /s /c`, with each argument quoted for `cmd.exe`.
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
}

const BATCH = /\.(cmd|bat)$/i

/** One argument as `cmd.exe` reads it from a `/s /c "…"` line: quoted for the
 *  program's own argument parser, then every character `cmd.exe` itself acts
 *  on escaped with `^`. A line break cannot be part of a `cmd.exe` command
 *  line at all, so it becomes a space. `twice` escapes a second time, for
 *  an argument a batch file passes on with `%*`: `cmd.exe` parses that line
 *  again, and a `"` in the argument turns quoting off for what follows it.
 * @public exported for its test */
export function quoteForCmd(arg: string, twice = false): string {
  const quoted = `"${arg
    .replace(/\r?\n/g, ' ')
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\+)$/, '$1$1')}"`
  const escaped = quoted.replace(/([()%!^"<>&|])/g, '^$1')
  return twice ? escaped.replace(/([()%!^"<>&|])/g, '^$1') : escaped
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
 * What to run for `file` and `args`. A `.cmd` or `.bat` on Windows becomes
 * `cmd.exe /d /s /c "<file> <args>"`; a bare name is looked up first; every
 * other case is returned as it is.
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
  // The file once, its arguments twice: a `.cmd` (npm's launcher) hands them
  // on to its program through `%*`, which `cmd.exe` parses a second time.
  // The program in real quotes: `cmd.exe` cuts a command name at its first space
  // unless it sees one, and a `^"` is not one. (A path has no `"` in it.)
  const line = [`"${target}"`, ...args.map((arg) => quoteForCmd(arg, true))].join(' ')
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
  const plan = launchPlan(file, args, { env: options.env ?? process.env, ...launch })
  const platform = launch.platform ?? process.platform
  try {
    return spawn(plan.file, plan.args, {
      ...options,
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
  const plan = launchPlan(file, args, { env: options.env, ...launch })
  const own = plan.verbatim
  let timedOut = false
  const child = execFile(
    plan.file,
    plan.args,
    {
      cwd: options.cwd,
      env: options.env,
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
