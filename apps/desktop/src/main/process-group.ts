/**
 * Asking what a pid is before signalling its process group: the agent's PTY
 * (`plugins/agent/main/host/pty.ts`, whose kill path explains why) and the
 * community plugins' servers both spawn their child as a group leader and
 * stop it by group, and both must never negate a pid they have not just
 * identified as theirs.
 */
import { execFileSync } from 'node:child_process'

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
export const defaultProbePid = (pid: number): PidState => {
  // pid 0 is "my own process group" and pid 1 is launchd — signalling either
  // would be catastrophic, so they can never be ours.
  if (!Number.isInteger(pid) || pid <= 1) return 'gone'
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
