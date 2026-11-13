/**
 * A process in a node-pty PTY: the one place Holi loads node-pty, for the
 * bottom panel's shells (`terminals.ts`) and the agent's clients, which reach
 * it through `plugin-api.ts`.
 *
 * node-pty is an Electron-ABI native module, so it loads lazily inside the
 * real spawn path only; tests inject a fake PTY and never touch it.
 */
import { commandLine, launchPlan } from '../launch'
import { defaultProbePid, killTree, type PidState, type Taskkill } from '../process-group'

/** The slice of node-pty's IPty Holi depends on (tests implement it directly). */
export interface PtyProcess {
  readonly pid: number
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

/** @public exported for its test */
export interface SpawnPtyOptions {
  cwd: string
  env: Record<string, string>
  /** Omitted → node-pty's own native default (80×24). */
  cols?: number
  rows?: number
}

export type SpawnPty = (file: string, args: string[], opts: SpawnPtyOptions) => PtyProcess

/** The only place node-pty is loaded — never reached under vitest. */
export const defaultSpawnPty: SpawnPty = (file, args, opts) => {
  const pty = require('node-pty') as typeof import('node-pty')
  // Canonical npm Node shims resolve to their script; opaque Windows batches
  // use cmd.exe. The Node fallback also needs a console parent on ConPTY.
  const launch = launchPlan(file, args, { env: opts.env })
  const env = launch.env ? { ...opts.env, ...launch.env } : opts.env
  if (process.platform === 'win32' && launch.env?.ELECTRON_RUN_AS_NODE === '1') {
    // Electron is a GUI executable: its Node mode attaches to its parent's
    // console. A console parent keeps it on ConPTY rather than Holi's console.
    // User argv travels as JSON, never as command-shell source.
    const spec = JSON.stringify({ file: launch.args[0], args: launch.args.slice(1) })
    if (spec.length > 30_000)
      throw new Error(
        'The Node fallback arguments exceed the Windows environment limit. Install Node.js to run this command.',
      )
    const bootstrap =
      "const s=JSON.parse(process.env.HOLI_NODE_PTY_SPEC);delete process.env.HOLI_NODE_PTY_SPEC;delete process.env.HOLI_NODE_PTY_EXEC;process.argv=[process.execPath,s.file,...s.args];process.execArgv=[];require('node:module').runMain(s.file)"
    const key = Object.keys(env).find((key) => key.toUpperCase() === 'COMSPEC')
    return pty.spawn(
      key ? env[key]! : 'cmd.exe',
      `/d /v:off /s /c "start "" /b /wait "%HOLI_NODE_PTY_EXEC%" -e "${bootstrap}""`,
      {
        name: 'xterm-256color',
        ...opts,
        env: { ...env, HOLI_NODE_PTY_EXEC: launch.file, HOLI_NODE_PTY_SPEC: spec },
      },
    ) as unknown as PtyProcess
  }
  return pty.spawn(launch.file, commandLine(launch), {
    name: 'xterm-256color',
    ...opts,
    env,
  }) as unknown as PtyProcess
}

/**
 * node-pty's own `kill`. On Windows it takes no signal and throws if given
 * one ("Signals not supported on windows"); elsewhere it passes the signal on.
 */
function killPty(
  pty: PtyProcess,
  signal: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32') pty.kill()
  else pty.kill(signal)
}

/**
 * Signal a PTY's child, choosing the target from what its pid IS right now.
 *
 * Never an unconditional `process.kill(-pid)`: node-pty reports an exit
 * asynchronously, and in the gap the kernel may have handed the pid to someone
 * else, whose whole group a negative pid would kill. So ask the OS first:
 * a `group-leader` is still our setsid'd child, and its group (the shell's
 * jobs, Claude's helpers) goes with it; a pid that is `alive` but leads no
 * group is signalled alone through node-pty; a `gone` one gets nothing.
 * The agent's runtime (`plugins/agent/main/host/pty.ts`) explains the history.
 *
 * On Windows there are no groups or signals: a live child is a tree root and
 * `killTree` stops the tree by `taskkill`, then the PTY itself is closed.
 */
export function signalPty(
  pty: PtyProcess,
  signal: 'SIGTERM' | 'SIGKILL' | 'SIGHUP',
  probePid: (pid: number) => PidState = defaultProbePid,
  platform: NodeJS.Platform = process.platform,
  taskkill?: Taskkill,
): void {
  switch (probePid(pty.pid)) {
    case 'group-leader':
      // Reaped between the probe and here is a no-op inside `killTree`.
      // On Windows the PTY is closed once `taskkill` has found the tree: closing
      // it first would end the root, and `/T` finds no root to walk down from.
      killTree(
        pty.pid,
        signal,
        platform,
        taskkill,
        platform === 'win32'
          ? () => {
              try {
                killPty(pty, signal, platform)
              } catch {
                // Already closed.
              }
            }
          : undefined,
      )
      return
    case 'alive':
      try {
        killPty(pty, signal, platform)
      } catch {
        // Raced with exit.
      }
      return
    case 'gone':
      return
  }
}

/** Why node-pty would not load, in words with the fix: a module built for
 *  another ABI is the usual cause (AGENTS.md). Null for any other error. */
export function nativeLoadHint(err: unknown): string | null {
  const text = err instanceof Error ? err.message : String(err)
  if (
    !/node-pty|NODE_MODULE_VERSION|pty\.node|was compiled against|Cannot find module/i.test(text)
  ) {
    return null
  }
  return (
    'The terminal module (node-pty) did not load for this Electron. Rebuild it with ' +
    '`pnpm --filter @holi/desktop run rebuild:natives` and restart Holi.'
  )
}
