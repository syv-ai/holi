/**
 * Asking what a pid is before signalling its process group: the agent's PTY
 * (`plugins/agent/main/host/pty.ts`, whose kill path explains why) and the
 * community plugins' servers both spawn their child as a group leader and
 * stop it by group, and both must never negate a pid they have not just
 * identified as theirs.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'

/**
 * What a pid is at the moment we are about to signal it.
 *  - `group-leader` — still the session leader we spawned; safe to signal the group
 *  - `alive`        — a live process that does NOT lead its own group
 *  - `gone`         — no such pid; nothing of ours to signal
 */
export type PidState = 'group-leader' | 'alive' | 'gone'

/**
 * Ask the OS what `pid` currently is. A node-pty child is setsid'd (and a `detached`
 * spawn starts its own group), so it leads a group whose id equals its own pid; that equality is what distinguishes our
 * child from a stranger who was handed the same pid after ours was reaped.
 */
export const defaultProbePid = (
  pid: number,
  platform: NodeJS.Platform = process.platform,
): PidState => {
  // pid 0 is "my own process group" and pid 1 is launchd — signalling either
  // would be catastrophic, so they can never be ours.
  if (!Number.isInteger(pid) || pid <= 1) return 'gone'
  // Windows has no process groups and no `ps`. What it has is a tree, and
  // `killTree` stops one by its root pid, so a live child we started is the
  // root of its own: `group-leader` here means "a tree root to stop whole".
  if (platform === 'win32') {
    try {
      process.kill(pid, 0)
      return 'group-leader'
    } catch (err) {
      // No permission means it is alive, and not ours to stop.
      return (err as NodeJS.ErrnoException).code === 'EPERM' ? 'alive' : 'gone'
    }
  }
  try {
    const pgid = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return Number(pgid) === pid ? 'group-leader' : 'alive'
  } catch {
    return 'gone' // ps exits non-zero when the pid does not exist
  }
}

/** Starts `taskkill` for a tree; tests inject it. */
export type Taskkill = (pid: number, done?: () => void) => void

const defaultTaskkill: Taskkill = (pid, done) => {
  const system = process.env.SystemRoot ?? process.env.windir
  const exe = system === undefined ? 'taskkill' : join(system, 'System32', 'taskkill.exe')
  const child = spawn(exe, ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  child.once('close', () => done?.())
  // No `taskkill` to run: stop the top process, which is all that is left to do.
  child.once('error', () => {
    try {
      process.kill(pid)
    } catch {
      // Already gone.
    }
    done?.()
  })
}

/**
 * Stop `pid` and everything it started. macOS and Linux signal the process
 * group (`-pid`, which is why the child is spawned as a group leader and why
 * the caller probes the pid first). Windows has no groups and no signals: the
 * tree goes by `taskkill /T /F` on the root pid, and a negative pid is never
 * used there, so `signal` is ignored. Windows has no graceful stop for a
 * console process either (`taskkill` without `/F` is refused for one), so
 * the first signal is already the forced one. Never throws; false when a
 * POSIX group could not be signalled.
 */
export function killTree(
  pid: number,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
  taskkill: Taskkill = defaultTaskkill,
  done?: () => void,
): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  if (platform === 'win32') {
    taskkill(pid, done)
    return true
  }
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    return false
  }
}

/**
 * `killTree` for a `ChildProcess` Holi started. On POSIX a group outlives its
 * leader, so a child that has exited may still have a group to stop, and it
 * is signalled as before. On Windows the tree hangs off the root's pid, and a
 * pid that has exited may already be another program's: nothing is sent.
 */
export function killChildTree(
  child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'>,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
  taskkill?: Taskkill,
): boolean {
  if (child.pid === undefined) return false
  if (platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return false
    return killTree(child.pid, signal, platform, taskkill)
  }
  const leader = defaultProbePid(child.pid, platform) === 'group-leader'
  if (!leader && child.exitCode === null && child.signalCode === null) return false
  if (!leader) {
    // The leader can exit before its descendants. A group id remains reserved
    // while any member exists; only signal it when the OS still reports a
    // member of that exact group, avoiding a bare signal to a recycled pid.
    try {
      const groups = execFileSync('ps', ['-o', 'pgid=', '-A'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      if (!groups.split(/\s+/).includes(String(child.pid))) return false
    } catch {
      return false
    }
  }
  return killTree(child.pid, signal, platform, taskkill)
}
