/**
 * One agent client in a node-pty PTY, its bytes forwarded to the renderer's
 * xterm. What runs in it (binary, arguments, environment) is the provider's
 * (`AgentProvider.terminal`).
 *
 * node-pty is an Electron-ABI native module, so it loads lazily inside the
 * real spawn path only; tests inject a fake PTY and never touch it.
 */

/** The slice of node-pty's IPty we depend on (tests implement it directly). */
export interface PtyProcess {
  readonly pid: number
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

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

// What a pid is right now lives in core, with the community plugins' servers
// as its other user (`main/process-group.ts`).
import { defaultProbePid, type PidState } from '../../../../main/plugin-api'
export { defaultProbePid, type PidState }

/**
 * There is deliberately **no login probe**. Claude Code asks for the login
 * itself, in the terminal; a copy of that state in Holi's chrome cannot be kept
 * in sync, because `/login` fires none of the events Holi sees.
 */

export interface AgentRuntimeDeps {
  spawnPty?: SpawnPty
  /** Liveness/ownership probe used before every signal (see `signal()`). */
  probePid?: (pid: number) => PidState
  /** SIGTERM → grace → SIGKILL. */
  killGraceMs?: number
  /** Cap on waiting for the exit event after SIGKILL. */
  killBackstopMs?: number
}

export interface StartArgs {
  bin: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols?: number
  rows?: number
}

export interface AgentExit {
  exitCode: number
  signal?: number
}

export class AgentRuntime {
  private pty: PtyProcess | null = null
  private dataCbs: Array<(data: string) => void> = []
  private exitCbs: Array<(e: AgentExit) => void> = []
  private exitWaiters: Array<() => void> = []
  private killTimer: ReturnType<typeof setTimeout> | null = null
  private readonly spawnPty: SpawnPty
  private readonly probePid: (pid: number) => PidState
  private readonly killGraceMs: number
  private readonly killBackstopMs: number

  constructor(deps: AgentRuntimeDeps = {}) {
    this.spawnPty = deps.spawnPty ?? defaultSpawnPty
    this.probePid = deps.probePid ?? defaultProbePid
    this.killGraceMs = deps.killGraceMs ?? 2_000
    this.killBackstopMs = deps.killBackstopMs ?? 5_000
  }

  get isRunning(): boolean {
    return this.pty !== null
  }

  /**
   * The child's pid while it runs, null otherwise.
   *
   * **The join key to Claude Code's own session listing**: a row there is
   * keyed by pid, and this is how Holi says which of its sessions a row is
   * about. Derived from `this.pty`, which `onExit` clears before it emits, so a
   * dead session reports null.
   */
  get pid(): number | null {
    return this.pty?.pid ?? null
  }

  onData(cb: (data: string) => void): void {
    this.dataCbs.push(cb)
  }

  onExit(cb: (e: AgentExit) => void): void {
    this.exitCbs.push(cb)
  }

  start({ bin, args, cwd, env, cols, rows }: StartArgs): void {
    if (this.pty) throw new Error('agent session already running')
    // cols/rows pass straight through — undefined lets node-pty default natively.
    const pty = this.spawnPty(bin, args, { cwd, env, cols, rows })
    this.pty = pty
    pty.onData((data) => {
      for (const cb of this.dataCbs) cb(data)
    })
    pty.onExit((e) => {
      // clear session state BEFORE emitting: listeners restart on exit, and a
      // restart racing a stale `pty` would spawn into a half-dead runtime
      if (this.pty === pty) this.pty = null
      if (this.killTimer) {
        clearTimeout(this.killTimer)
        this.killTimer = null
      }
      for (const cb of this.exitCbs) cb({ exitCode: e.exitCode, signal: e.signal })
      for (const resolve of this.exitWaiters.splice(0)) resolve()
    })
  }

  write(data: string): void {
    this.pty?.write(data)
  }

  resize(cols: number, rows: number): void {
    this.pty?.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)))
  }

  /**
   * SIGTERM the child's whole **process group** (node-pty children are session
   * leaders, so `claude`'s helper subprocesses — node sidecars, ripgrep — die
   * with it; a bare pty.kill leaks them), escalating to SIGKILL after the
   * grace period. Resolves when the child is actually reaped.
   */
  async kill(): Promise<void> {
    const pty = this.pty
    if (!pty) return

    const exited = new Promise<void>((resolve) => {
      this.exitWaiters.push(resolve)
      setTimeout(resolve, this.killBackstopMs) // never hang a vault switch on a zombie
    })

    this.signal(pty, 'SIGTERM')
    this.killTimer = setTimeout(() => {
      this.killTimer = null
      if (this.pty === pty) this.signal(pty, 'SIGKILL')
    }, this.killGraceMs)

    await exited
  }

  /**
   * Signal the child, choosing the target from what the pid IS right now.
   *
   * ┌─ READ THIS BEFORE TOUCHING THE KILL PATH ────────────────────────────┐
   * Never an unconditional `process.kill(-pty.pid, signal)`: that once killed
   * unrelated applications on a developer's machine.
   *
   * `kill(-pid)` signals an entire process GROUP, and node-pty reports the
   * child's exit asynchronously. Between the kernel reaping the child (which
   * frees its pid for reuse *immediately*) and our `onExit` running, `this.pty`
   * still looks live, so a signal could hit a pid the OS already handed to
   * someone else, and the negative of it kills their whole group. The window is
   * tiny but lands under heavy pid churn plus load. Guard it anyway.
   *
   * So: never signal a pid on the strength of a JS object still existing. Ask
   * the OS what the pid is, immediately before signalling, every time.
   *   - `group-leader` → still our setsid'd child; signal the group, which is
   *     the whole point here (claude's helpers — node sidecars, ripgrep — die
   *     with it instead of leaking).
   *   - `alive` → a live pid that does not lead its own group, so it cannot be
   *     our node-pty child's session. Signal only the child via node-pty; NEVER
   *     negate a pid we have not positively identified as ours.
   *   - `gone` → already reaped. Send nothing. There is no one left to signal
   *     and the pid may already belong to someone else.
   * └──────────────────────────────────────────────────────────────────────┘
   */
  private signal(pty: PtyProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
    // Cheap guard first: onExit nulls `this.pty`, so a mismatch means we
    // already know it is dead without paying for a probe.
    if (this.pty !== pty) return

    switch (this.probePid(pty.pid)) {
      case 'group-leader':
        try {
          process.kill(-pty.pid, signal) // negative pid = the whole group
        } catch {
          // Reaped between the probe and here: the residual race is now bounded
          // by these two statements rather than by a callback round-trip. The
          // pid cannot have been *reused* that fast, so this is a plain no-op.
        }
        return
      case 'alive':
        try {
          pty.kill(signal)
        } catch {
          // raced with exit
        }
        return
      case 'gone':
        return
    }
  }
}
