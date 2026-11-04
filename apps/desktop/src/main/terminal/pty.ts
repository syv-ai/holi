/**
 * A process in a node-pty PTY: the one place Holi loads node-pty, for the
 * bottom panel's shells (`terminals.ts`) and the agent's clients, which reach
 * it through `plugin-api.ts`.
 *
 * node-pty is an Electron-ABI native module, so it loads lazily inside the
 * real spawn path only; tests inject a fake PTY and never touch it.
 */
import { defaultProbePid, type PidState } from '../process-group'

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
  return pty.spawn(file, args, { name: 'xterm-256color', ...opts }) as unknown as PtyProcess
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
 */
export function signalPty(
  pty: PtyProcess,
  signal: 'SIGTERM' | 'SIGKILL' | 'SIGHUP',
  probePid: (pid: number) => PidState = defaultProbePid,
): void {
  switch (probePid(pty.pid)) {
    case 'group-leader':
      try {
        process.kill(-pty.pid, signal)
      } catch {
        // Reaped between the probe and here.
      }
      return
    case 'alive':
      try {
        pty.kill(signal)
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
