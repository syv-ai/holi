/**
 * Running a plugin's commands: its `setup` once per install, its `check` when
 * asked whether it can work now, and its `serve` per opened file
 * (`supervisor.ts`). Both are argv arrays from the manifest,
 * run without a shell, in the plugin's own folder, on the PATH a GUI launch
 * lacks (`toolPath`).
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  joinOwnedProgram,
  killChildTree,
  spawnOwnedProgram,
  toolPath,
  withPath,
} from '../../../main/plugin-api'

/** What a command's `{file}`, `{vault}` and `{port}` stand for. */
export interface CommandValues {
  file?: string
  vault?: string
  port?: number
}

/** `argv` with its placeholders filled in. One owner: setup and serve both
 *  expand through here. */
export function expandCommand(argv: readonly string[], values: CommandValues): string[] {
  const fill: Record<string, string | undefined> = {
    '{file}': values.file,
    '{vault}': values.vault,
    '{port}': values.port === undefined ? undefined : String(values.port),
  }
  return argv.map((arg) =>
    arg.replace(/\{(file|vault|port)\}/g, (m) => {
      const value = fill[m]
      if (value === undefined) throw new Error(`${m} has no value here`)
      return value
    }),
  )
}

/** The environment a plugin's commands run in. */
export function pluginEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // One PATH key: a Windows copy of `process.env` has `Path`, not `PATH`.
  return { ...withPath(process.env, toolPath()), FORCE_COLOR: '0', ...extra }
}

/**
 * Run `argv` in `cwd` to its end, its output going line by line to `onLine`
 * and whole to `logPath`. Resolves true for exit code 0.
 */
export async function runSetup(args: {
  argv: readonly string[]
  cwd: string
  logPath: string
  onLine(line: string): void
  signal?: AbortSignal
}): Promise<boolean> {
  await mkdir(dirname(args.logPath), { recursive: true })
  const log = createWriteStream(args.logPath)
  const closed = new Promise<void>((resolve) => log.once('close', resolve))
  let logFailed = false
  log.on('error', () => {
    logFailed = true
  })
  const [command, ...rest] = args.argv
  const lines = splitLines(args.onLine)
  const take = (chunk: Buffer) => {
    log.write(chunk)
    lines.push(chunk.toString('utf8'))
  }
  const report = (line: string) => {
    log.write(`${line}\n`)
    args.onLine(line)
  }
  let detach = () => {}
  let ok = false
  try {
    if (args.signal?.aborted) return false
    const platform = process.platform
    const child = spawnOwnedProgram(command!, rest, {
      cwd: args.cwd,
      env: pluginEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    const joined = joinOwnedProgram(child, platform)
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    const stop = () => {
      // POSIX descendants can keep the pipes open after the leader exits.
      // Probe before signalling the group; Windows uses the exact Job channel.
      if (platform === 'win32') {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      } else if (!killChildTree(child, 'SIGKILL') && child.exitCode === null) {
        child.kill('SIGKILL')
      }
    }
    args.signal?.addEventListener('abort', stop, { once: true })
    detach = () => {
      args.signal?.removeEventListener('abort', stop)
      child.stdout?.off('data', take)
      child.stderr?.off('data', take)
    }
    let result
    try {
      result = await joined
    } catch (error) {
      report(String(error))
      // A failed receipt doesn't wait for held child pipes. Still close our log
      // and preserve the typed proof failure even if log output also fails.
      throw error
    }
    if (result.error) report(`could not run ${command}: ${result.error.message}`)
    else if (result.ownership === 'not-started') report(`could not start ${command}`)
    else if (result.code !== 0) report(`exited with ${result.code}`)
    ok = result.code === 0 && result.error === null
  } finally {
    detach()
    lines.flush()
    log.end()
    // Even a log write error cannot substitute for closing its file handle.
    await closed
  }
  return ok && !logFailed && !args.signal?.aborted
}

/** How long a plugin's `check` may take before it counts as failed. */
const CHECK_TIMEOUT_MS = 10_000

/**
 * Run a plugin's `check` in `cwd`, its output ignored. Resolves true for exit
 * code 0 within `timeoutMs`; a check still running then, or when `signal`
 * aborts, is killed, with anything it started, and fails.
 */
export async function runCheck(args: {
  argv: readonly string[]
  cwd: string
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<boolean> {
  if (args.signal?.aborted) return false
  const platform = process.platform
  const [command, ...rest] = args.argv
  // Its own process group, so a kill stops what it started too.
  const child = spawnOwnedProgram(command!, rest, {
    cwd: args.cwd,
    env: pluginEnv(),
    stdio: 'ignore',
    detached: true,
  })
  if (platform === 'win32') {
    const joined = joinOwnedProgram(child, platform)
    let stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    const timer = setTimeout(stop, args.timeoutMs ?? CHECK_TIMEOUT_MS)
    args.signal?.addEventListener('abort', stop, { once: true })
    return joined
      .then(({ code, error }) => !stopped && code === 0 && error === null)
      .finally(() => {
        clearTimeout(timer)
        args.signal?.removeEventListener('abort', stop)
      })
  }
  // Preserve the POSIX check's group signal and immediate timeout answer.
  return new Promise((resolve) => {
    const finish = (ok: boolean) => {
      clearTimeout(timer)
      args.signal?.removeEventListener('abort', stop)
      resolve(ok)
    }
    const stop = () => {
      if (child.exitCode === null && child.signalCode === null) {
        if (!killChildTree(child, 'SIGKILL')) child.kill('SIGKILL')
      }
      finish(false)
    }
    const timer = setTimeout(stop, args.timeoutMs ?? CHECK_TIMEOUT_MS)
    args.signal?.addEventListener('abort', stop, { once: true })
    child.once('error', () => finish(false))
    child.once('close', (code) => finish(code === 0))
  })
}

/** A line splitter over chunks of output. */
export function splitLines(onLine: (line: string) => void) {
  let rest = ''
  return {
    push(text: string) {
      const parts = (rest + text).split(/\r?\n/)
      rest = parts.pop() ?? ''
      for (const line of parts) onLine(line)
    },
    flush() {
      if (rest !== '') onLine(rest)
      rest = ''
    },
  }
}
