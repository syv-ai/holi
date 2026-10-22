/**
 * Running a plugin's commands: its `setup` once per install, its `check` when
 * asked whether it can work now, and its `serve` per opened file
 * (`supervisor.ts`). Both are argv arrays from the manifest,
 * run without a shell, in the plugin's own folder, on the PATH a GUI launch
 * lacks (`toolPath`).
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { defaultProbePid, toolPath } from '../../../main/plugin-api'

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
  return { ...process.env, PATH: toolPath(), FORCE_COLOR: '0', ...extra }
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
}): Promise<boolean> {
  await mkdir(dirname(args.logPath), { recursive: true })
  const log = createWriteStream(args.logPath)
  const [command, ...rest] = args.argv
  return new Promise((resolve) => {
    const child = spawn(command!, rest, {
      cwd: args.cwd,
      env: pluginEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const lines = splitLines(args.onLine)
    const take = (chunk: Buffer) => {
      log.write(chunk)
      lines.push(chunk.toString('utf8'))
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    const finish = (ok: boolean, why?: string) => {
      if (why !== undefined) {
        log.write(`${why}\n`)
        args.onLine(why)
      }
      lines.flush()
      log.end()
      resolve(ok)
    }
    child.once('error', (err) => finish(false, `could not run ${command}: ${err.message}`))
    child.once('close', (code) =>
      finish(code === 0, code === 0 ? undefined : `exited with ${code}`),
    )
  })
}

/** How long a plugin's `check` may take before it counts as failed. */
export const CHECK_TIMEOUT_MS = 10_000

/**
 * Run a plugin's `check` in `cwd`, its output ignored. Resolves true for exit
 * code 0 within `timeoutMs`; a check still running then is killed, with
 * anything it started, and fails.
 */
export function runCheck(args: {
  argv: readonly string[]
  cwd: string
  timeoutMs?: number
}): Promise<boolean> {
  const [command, ...rest] = args.argv
  return new Promise((resolve) => {
    // Its own process group, so a timeout stops what it started too.
    const child = spawn(command!, rest, {
      cwd: args.cwd,
      env: pluginEnv(),
      stdio: 'ignore',
      detached: true,
    })
    const timer = setTimeout(() => {
      const pid = child.pid
      if (pid !== undefined && defaultProbePid(pid) === 'group-leader') {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          // Gone in between.
        }
      }
      resolve(false)
    }, args.timeoutMs ?? CHECK_TIMEOUT_MS)
    const finish = (ok: boolean) => {
      clearTimeout(timer)
      resolve(ok)
    }
    child.once('error', () => finish(false))
    child.once('exit', (code) => finish(code === 0))
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
