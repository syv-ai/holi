/**
 * One agent client in a node-pty PTY, its bytes forwarded to the renderer's
 * xterm. What runs in it (binary, arguments, environment) is the provider's
 * (`AgentProvider.terminal`).
 *
 * node-pty is an Electron-ABI native module, so it loads lazily inside the
 * real spawn path only; tests inject a fake PTY and never touch it.
 */

// The PTY itself is core's (`main/terminal/pty.ts`), shared with the bottom
// panel's shells: one place loads node-pty.
import {
  defaultSpawnPty,
  preparePosixLaunch,
  signalPty,
  type PosixLaunch,
  type ProcessGroupSupervision,
  type PtyProcess,
  type SpawnPty,
} from '../../../../main/plugin-api'
import { bounded } from './bounded'
export type { PtyProcess, SpawnPty }

// What a pid is right now lives in core, with the community plugins' servers
// as its other user (`main/process-group.ts`).
import { defaultProbePid, type PidState } from '../../../../main/plugin-api'
/** @public exported for its test */
export { defaultProbePid, type PidState }

/**
 * There is deliberately **no login probe**. Claude Code asks for the login
 * itself, in the terminal; a copy of that state in Holi's chrome cannot be kept
 * in sync, because `/login` fires none of the events Holi sees.
 */

export interface AgentRuntimeDeps {
  spawnPty?: SpawnPty
  /** Probe for the Windows/unsupervised compatibility path only. */
  probePid?: (pid: number) => PidState
  /** The OS to stop a child as; tests run both branches on any machine. */
  platform?: NodeJS.Platform
  /** Windows: how a tree is stopped, so a test never runs the real one. */
  taskkill?: (pid: number) => void
  /** SIGTERM → grace → SIGKILL. */
  killGraceMs?: number
  /** Cap on waiting for public PTY exit, not on physical proof or callbacks. */
  killBackstopMs?: number
  /** Test adapter for native process-group ownership; never inferred from a fake pid. */
  superviseGroup?: (pid: number) => ProcessGroupSupervision
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

/** node-pty 1.1.0's UnixTerminal sets this own field in the native exit
 * callback, before waiting for socket close (or its 200 ms backstop). Its public
 * onExit is the output edge, not the root edge. Observe the assignment on this
 * instance only; never infer process ownership or signal anything from it. */
function observeUnixRootExit(pty: PtyProcess, notify: () => void, required: boolean): void {
  const field = Object.getOwnPropertyDescriptor(pty, '_boundClose')
  if (!field?.configurable || field.value !== false) {
    if (required) throw new Error('Unsupported node-pty Unix root-exit interface.')
    return
  }
  let bound = false
  Object.defineProperty(pty, '_boundClose', {
    configurable: true,
    enumerable: field.enumerable ?? false,
    get: () => bound,
    set: (value: boolean) => {
      bound = value
      if (value) notify()
    },
  })
}

/** A native adapter may already hold cleanup authority when it throws. */
export function ptyLaunchCleanup(error: unknown): Promise<unknown> | undefined {
  if (typeof error !== 'object' || error === null || !('cleanupPromise' in error)) return
  const cleanup = error.cleanupPromise
  if (cleanup && typeof (cleanup as PromiseLike<unknown>).then === 'function')
    return Promise.resolve(cleanup)
}

export class AgentRuntime {
  private pty: PtyProcess | null = null
  private dataCbs: Array<(data: string) => void> = []
  private drainingCbs: Array<() => void> = []
  private draining = false
  private drainingErrors: unknown[] = []
  private exitCbs: Array<(e: AgentExit, signal?: AbortSignal) => void | Promise<void>> = []
  private notifyPublicExit?: () => void
  private killTimer: ReturnType<typeof setTimeout> | null = null
  private killPromise: Promise<void> | null = null
  private readonly spawnPty: SpawnPty
  private readonly probePid: (pid: number) => PidState
  private readonly platform: NodeJS.Platform
  private readonly taskkill: ((pid: number) => void) | undefined
  private readonly killGraceMs: number
  private readonly killBackstopMs: number
  private readonly superviseGroup?: (pid: number) => ProcessGroupSupervision
  private supervision?: ProcessGroupSupervision
  private startupCleanup?: Promise<void>
  private exitSettlement?: Promise<void>
  private physicalDrain?: Promise<void>
  private exitReported = false
  private outputExpired = false
  private exitBackstop?: ReturnType<typeof setTimeout>

  constructor(deps: AgentRuntimeDeps = {}) {
    this.spawnPty = deps.spawnPty ?? defaultSpawnPty
    this.probePid = deps.probePid ?? (deps.spawnPty ? () => 'alive' : defaultProbePid)
    this.platform = deps.platform ?? process.platform
    this.taskkill = deps.taskkill
    this.killGraceMs = deps.killGraceMs ?? 2_000
    this.killBackstopMs = deps.killBackstopMs ?? 5_000
    this.superviseGroup = deps.superviseGroup
  }

  get isRunning(): boolean {
    return this.pty !== null
  }

  /**
   * The child's pid while it runs, null otherwise.
   *
   * **The join key to Claude Code's own session listing**: a row there is
   * keyed by pid, and this is how Holi says which of its sessions a row is
   * about. It remains owned until physical drainage and its exit callbacks finish.
   */
  get pid(): number | null {
    return this.pty?.pid ?? null
  }

  onData(cb: (data: string) => void): void {
    this.dataCbs.push(cb)
  }

  /** Stop admitting turn work now. Output and ownership can still be live. */
  onDraining(cb: () => void): void {
    this.drainingCbs.push(cb)
  }

  /** Native-start failure cleanup, independent of whether a PTY was returned. */
  get failedLaunchCleanup(): Promise<void> | undefined {
    return this.startupCleanup
  }

  onExit(cb: (e: AgentExit, signal?: AbortSignal) => void | Promise<void>): void {
    this.exitCbs.push(cb)
  }

  start({ bin, args, cwd, env, cols, rows }: StartArgs): void {
    if (this.pty) throw new Error('agent session already running')
    if (this.startupCleanup) throw new Error('previous agent launch cleanup has not succeeded')
    // Prepare synchronously so start() retains its public interface. Binding is
    // observed immediately and joined by drain, including natural early exit.
    let prepared: PosixLaunch | undefined
    let invoked = false
    this.killPromise = null
    this.draining = false
    this.drainingErrors = []
    this.exitReported = false
    this.outputExpired = false
    this.exitSettlement = undefined
    this.physicalDrain = undefined
    try {
      const native = this.spawnPty === defaultSpawnPty ? defaultSpawnPty.preload?.() : undefined
      if (this.spawnPty === defaultSpawnPty && this.platform !== 'win32')
        prepared = preparePosixLaunch(bin, args, {
          cwd,
          env: { ...env, PWD: cwd, TERM: 'xterm-256color' },
        })
      const executable = prepared?.executable ?? bin
      const argv = prepared?.args ?? args
      const options = { cwd, env: prepared?.options.env ?? env, cols, rows }
      const invoke = native?.(executable, argv, options)
      invoked = true
      const pty = invoke ? invoke() : this.spawnPty(executable, argv, options)
      this.supervision = prepared ? { drain: prepared.drain } : this.superviseGroup?.(pty.pid)
      if (this.supervision && this.platform !== 'win32')
        observeUnixRootExit(pty, () => this.beginDrain(), prepared !== undefined)
      pty.onData((data) => {
        if (this.pty !== pty) return
        for (const cb of this.dataCbs) cb(data)
      })
      pty.onExit((e) => {
        if (this.pty !== pty || this.exitReported || this.outputExpired) return
        this.exitReported = true
        this.beginDrain()
        clearTimeout(this.exitBackstop)
        if (this.killTimer) {
          clearTimeout(this.killTimer)
          this.killTimer = null
        }
        this.exitSettlement = (async () => {
          if (this.physicalDrain) await this.physicalDrain
          if (this.drainingErrors.length)
            throw new AggregateError(this.drainingErrors, 'PTY drain notification failed.')
          const controller = new AbortController()
          const event = { exitCode: e.exitCode, signal: e.signal }
          const finish = (from: number): void | Promise<void> => {
            for (let i = from; i < this.exitCbs.length; i++) {
              const completion = this.exitCbs[i]!(event, controller.signal)
              if (completion !== undefined)
                return completion.then(() => {
                  controller.signal.throwIfAborted()
                  return finish(i + 1)
                })
            }
          }
          const work = finish(0)
          if (work !== undefined) {
            try {
              await bounded(work, `PTY ${pty.pid} exit callbacks`)
            } catch (error) {
              controller.abort(error)
              throw error
            }
          }
          this.pty = null
        })()
        void this.exitSettlement.catch(() => {})
        this.notifyPublicExit?.()
      })
      if (prepared) void prepared.bind(pty.pid).catch(() => {})
      this.pty = pty
    } catch (error) {
      const cleanup = [ptyLaunchCleanup(error)]
      // node-pty can throw after posix_spawn/forkpty, even before installing
      // its native exit callback. The lease can find that root without an IPty.
      if (prepared) cleanup.push(prepared.cancel(invoked ? 'possibly-launched' : 'unlaunched'))
      if (cleanup.some((work) => work !== undefined)) {
        this.startupCleanup = Promise.allSettled(cleanup).then((results) => {
          const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []))
          if (failures.length > 0)
            throw new AggregateError([error, ...failures], 'PTY launch and cleanup failed.', {
              cause: error,
            })
          this.startupCleanup = undefined
        })
        void this.startupCleanup.catch(() => {})
      }
      throw error
    }
  }

  private beginDrain(): void {
    if (this.draining) return
    this.draining = true
    for (const cb of this.drainingCbs) {
      try {
        cb()
      } catch (error) {
        this.drainingErrors.push(error)
      }
    }
    if (!this.supervision) return
    try {
      this.physicalDrain = this.supervision.drain()
    } catch (error) {
      this.physicalDrain = Promise.reject(error)
    }
    void this.physicalDrain.catch(() => {})
  }

  write(data: string): void {
    this.pty?.write(data)
  }

  resize(cols: number, rows: number): void {
    this.pty?.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)))
  }

  /** Join physical POSIX proof, public PTY exit (after tail output), and
   * async exit callbacks. Windows and injected unsupervised PTYs retain the
   * legacy signalling path; their public exit is not POSIX kernel proof. */
  kill(): Promise<void> {
    if (this.startupCleanup) return this.startupCleanup
    if (this.killPromise !== null) return this.killPromise
    if (this.exitSettlement) return this.exitSettlement
    const pty = this.pty
    if (!pty) return Promise.resolve()
    this.beginDrain()
    const pending = this.killAndWait(pty)
    this.killPromise = pending
    return pending
  }

  private async killAndWait(pty: PtyProcess): Promise<void> {
    // The lease owns the physical deadline and its original failure. A PTY
    // output timer never runs while that proof is still pending.
    if (this.physicalDrain) await this.physicalDrain
    if (this.exitSettlement) return this.exitSettlement

    const exited = new Promise<void>((resolve, reject) => {
      this.notifyPublicExit = resolve
      this.exitBackstop = setTimeout(() => {
        // A late output edge must not retire a failed POSIX owner. Legacy
        // unsupervised terminals can still present their eventual exit.
        if (this.supervision) this.outputExpired = true
        reject(new Error(`PTY ${pty.pid} did not report process exit before teardown timed out.`))
      }, this.killBackstopMs)
    })
    try {
      if (!this.supervision) {
        this.signal(pty, 'SIGTERM')
        if (!this.exitReported) {
          this.killTimer = setTimeout(() => {
            this.killTimer = null
            if (this.pty === pty) this.signal(pty, 'SIGKILL')
          }, this.killGraceMs)
        }
      }
      await exited
    } finally {
      clearTimeout(this.exitBackstop)
      this.notifyPublicExit = undefined
    }
    return this.exitSettlement
  }

  /** Only for the compatibility path. Never infer native POSIX signal
   * authority from a PTY object or a recycled numeric PID. */
  private signal(pty: PtyProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
    if (this.pty !== pty || this.exitReported) return

    signalPty(pty, signal, this.probePid, this.platform, this.taskkill)
  }
}
