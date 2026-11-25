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
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  defaultSpawnPty,
  launchOwnedWindowsPty,
  posixLaunchNonAdmission,
  preparePosixLaunch,
  signalPty,
  type PosixLaunch,
  type ProcessGroupSupervision,
  type PtyProcess,
  type SpawnPty,
} from '../../../../main/plugin-api'
import { bounded } from './bounded'
import type { FencedOwnership, LaunchOwnership } from './ownership'

interface PtyOwnership {
  cwd: string
  allocate(proof: 'native' | 'explicit'): LaunchOwnership
  /** A fence has already linked scratch even if terminal preflight refuses. */
  fence?: FencedOwnership
}
const ptyOwnership = new AsyncLocalStorage<PtyOwnership>()

/** Carry activation ownership through the synchronous terminal-open interface.
 * A fenced start also carries its pre-linked scratch through provider setup. */
export function withPtyOwnership<T>(scope: PtyOwnership, start: () => T): T {
  if (ptyOwnership.getStore()?.fence && ptyOwnership.getStore()?.cwd === scope.cwd) return start()
  return ptyOwnership.run(scope, start)
}

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
  activationSignal?: AbortSignal
  launchWindowsPty?: typeof launchOwnedWindowsPty
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
  /** Native startup was cancelled before GO; no provider ran. */
  nonAdmission?: true
}

/** A closed activation refused entry before invoking a PTY adapter. */
class PtyAdmissionClosed extends Error {
  constructor() {
    super('The vault was left before the terminal opened.')
  }
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
  private windowsLaunch?: ReturnType<typeof launchOwnedWindowsPty>
  private dataCbs: Array<(data: string) => void> = []
  private drainingCbs: Array<(physical?: Promise<void>) => void> = []
  private draining = false
  private exitFailure?: { cause: unknown }
  private exitCbs: Array<(e: AgentExit, signal?: AbortSignal) => void | Promise<void>> = []
  private closedCb?: () => void
  private abandonedCb?: () => void
  private notifyPublicExit?: () => void
  private killTimer: ReturnType<typeof setTimeout> | null = null
  private settlement: Promise<void> | null = null
  private readonly spawnPty: SpawnPty
  private readonly launchWindowsPty: typeof launchOwnedWindowsPty
  private readonly probePid: (pid: number) => PidState
  private readonly platform: NodeJS.Platform
  private readonly taskkill: ((pid: number) => void) | undefined
  private readonly killGraceMs: number
  private readonly killBackstopMs: number
  private readonly superviseGroup?: (pid: number) => ProcessGroupSupervision
  private readonly activationSignal: AbortSignal | undefined
  private supervision?: ProcessGroupSupervision
  private ownership?: LaunchOwnership
  private fence?: FencedOwnership
  private startupCleanup?: Promise<void>
  private callbackSettlement?: Promise<void>
  private physicalDrain?: Promise<void>
  private exitReported = false
  private outputExpired = false
  private exitBackstop?: ReturnType<typeof setTimeout>

  constructor(deps: AgentRuntimeDeps = {}) {
    this.spawnPty = deps.spawnPty ?? defaultSpawnPty
    this.launchWindowsPty = deps.launchWindowsPty ?? launchOwnedWindowsPty
    this.probePid = deps.probePid ?? (deps.spawnPty ? () => 'alive' : defaultProbePid)
    this.platform = deps.platform ?? process.platform
    this.taskkill = deps.taskkill
    this.killGraceMs = deps.killGraceMs ?? 2_000
    this.killBackstopMs = deps.killBackstopMs ?? 5_000
    this.superviseGroup = deps.superviseGroup
    this.activationSignal = deps.activationSignal
  }

  get isRunning(): boolean {
    return this.pty !== null || this.windowsLaunch !== undefined
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
  onDraining(cb: (physical?: Promise<void>) => void): void {
    this.drainingCbs.push(cb)
  }

  /** Native-start failure cleanup, independent of whether a PTY was returned. */
  get failedLaunchCleanup(): Promise<void> | undefined {
    return this.startupCleanup
  }

  onExit(cb: (e: AgentExit, signal?: AbortSignal) => void | Promise<void>): void {
    this.exitCbs.push(cb)
  }

  /** The terminal owner's synchronous index update, only after full closure.
   * Unlike onExit, this notification does no fallible work. */
  onClosed(cb: () => void): void {
    this.closedCb = cb
  }

  /** Exit cannot complete, but the process is independently proved absent. */
  onExitAbandoned(cb: () => void): void {
    this.abandonedCb = cb
  }

  start({ bin, args, cwd, env, cols, rows }: StartArgs): void {
    if (this.pty || this.windowsLaunch) throw new Error('agent session already running')
    if (this.platform === 'win32' && (!this.spawnPty || this.spawnPty === defaultSpawnPty)) {
      this.startWindows({ bin, args, cwd, env, cols, rows })
      return
    }
    if (this.startupCleanup) throw new Error('previous agent launch cleanup has not succeeded')
    // Prepare synchronously so start() retains its public interface. Binding is
    // observed immediately and joined by drain, including natural early exit.
    let prepared: PosixLaunch | undefined
    let invoked = false
    let preparingLease = false
    const scope = this.platform !== 'win32' ? ptyOwnership.getStore() : undefined
    const ownership = scope?.cwd === cwd ? scope : undefined
    this.fence = this.ownership = ownership?.fence
    this.supervision = undefined
    this.settlement = null
    this.draining = false
    this.exitFailure = undefined
    this.exitReported = false
    this.outputExpired = false
    this.callbackSettlement = undefined
    this.physicalDrain = undefined
    let binding: Promise<ProcessGroupSupervision> | undefined
    const assertAdmission = () => {
      if (this.activationSignal?.aborted) throw new PtyAdmissionClosed()
    }
    try {
      assertAdmission()
      const useLease = this.spawnPty === defaultSpawnPty && this.platform !== 'win32'
      const native = this.spawnPty === defaultSpawnPty ? defaultSpawnPty.preload?.() : undefined
      const preflight = native?.(bin, args, { cwd, env, cols, rows })
      if (ownership && !useLease && !this.superviseGroup)
        throw new Error('An owned PTY adapter must provide explicit physical proof.')
      assertAdmission()
      if (ownership) this.ownership = ownership.allocate(useLease ? 'native' : 'explicit')
      if (useLease) {
        assertAdmission()
        preparingLease = true
        prepared = preparePosixLaunch(bin, args, {
          cwd,
          env: { ...env, PWD: cwd, TERM: 'xterm-256color' },
          ownershipRecordPath: this.ownership?.ownershipRecordPath,
        })
        preparingLease = false
      }
      const executable = prepared?.executable ?? bin
      const argv = prepared?.args ?? args
      const options = { cwd, env: prepared?.options.env ?? env, cols, rows }
      const invoke = prepared ? native?.(executable, argv, options) : preflight
      assertAdmission()
      invoked = true
      const pty = invoke ? invoke() : this.spawnPty(executable, argv, options)
      this.supervision = prepared ? { drain: prepared.drain } : this.superviseGroup?.(pty.pid)
      if (this.supervision && this.platform !== 'win32')
        observeUnixRootExit(
          pty,
          () => {
            if (this.pty === pty) this.settleOwnedExit(pty)
          },
          prepared !== undefined,
        )
      pty.onData((data) => {
        if (this.pty !== pty || this.exitFailure) return
        for (const cb of this.dataCbs) cb(data)
      })
      pty.onExit((e) => {
        if (this.pty !== pty || this.exitReported || this.outputExpired) return
        this.exitReported = true
        if (this.supervision && this.platform !== 'win32') this.settleOwnedExit(pty)
        else this.beginDrain()
        clearTimeout(this.exitBackstop)
        if (this.killTimer) {
          clearTimeout(this.killTimer)
          this.killTimer = null
        }
        this.callbackSettlement = (async () => {
          if (this.physicalDrain) await this.physicalDrain
          if (this.exitFailure) throw this.exitFailure.cause
          const controller = new AbortController()
          const event: AgentExit = { exitCode: e.exitCode, signal: e.signal }
          if (binding) {
            try {
              await binding
            } catch (error) {
              const refusal = posixLaunchNonAdmission(error)
              if (!refusal) throw error
              await refusal.cleanup
              this.ownership?.nonLaunch()
              event.nonAdmission = true
            }
          }
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
          this.ownership?.retire()
          this.pty = null
          this.closedCb?.()
        })().catch((error: unknown) => {
          throw this.rememberExitFailure(error)
        })
        if (this.supervision && this.platform !== 'win32') {
          // This is only the callback phase. The shared owner joins it; it
          // must not join the owner (which is also waiting for public exit).
          void this.callbackSettlement.catch(() => {})
        } else this.observeExit(this.callbackSettlement)
        this.notifyPublicExit?.()
      })
      if (prepared) {
        binding = prepared.bind(pty.pid)
        void binding.catch(() => {})
      }
      this.pty = pty
      // Invalidation can reenter a synchronous adapter before the terminal is
      // indexed. Bind first, then revoke in this turn, before startup can GO.
      if (this.platform !== 'win32' && this.activationSignal?.aborted)
        void this.kill().catch(() => {})
    } catch (error) {
      const refusal = preparingLease ? posixLaunchNonAdmission(error) : undefined
      const cleanup = [refusal?.cleanup ?? ptyLaunchCleanup(error)]
      // node-pty can throw after posix_spawn/forkpty, even before installing
      // its native exit callback. The lease can find that root without an IPty.
      if (prepared) cleanup.push(prepared.cancel(invoked ? 'possibly-launched' : 'unlaunched'))
      else if (invoked && this.supervision)
        cleanup.push(Promise.resolve().then(this.supervision.drain))
      // A prepared lease that never bound cannot write GO, even when the
      // native invocation created a root before throwing. Join cleanup first.
      const noLaunch =
        (prepared !== undefined && binding === undefined) ||
        (!invoked && (!preparingLease || refusal !== undefined))
      const finish = () => {
        if (noLaunch) this.ownership?.nonLaunch()
        // The fenced caller still has to remove its source and provider state.
        if (!ownership?.fence) this.ownership?.retire()
      }
      if (cleanup.some((work) => work !== undefined)) {
        this.startupCleanup = Promise.allSettled(cleanup).then((results) => {
          const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []))
          if (failures.length > 0)
            throw new AggregateError([error, ...failures], 'PTY launch and cleanup failed.', {
              cause: error,
            })
          finish()
          this.startupCleanup = undefined
        })
        this.observe(this.startupCleanup)
      } else if (!noLaunch && this.ownership) {
        // No retained proof: a returned error is not a non-admission receipt.
        this.startupCleanup = Promise.reject(error)
        this.observe(this.startupCleanup)
      } else if (this.ownership) {
        try {
          finish()
        } catch (failure) {
          this.startupCleanup = Promise.reject(failure)
          this.observe(this.startupCleanup)
        }
      }
      throw error
    }
  }

  private startWindows(args: StartArgs): void {
    const scope = ptyOwnership.getStore()
    const ownership = scope?.cwd === args.cwd ? scope : undefined
    this.fence = this.ownership = ownership?.fence
    this.draining = false
    this.exitFailure = undefined
    this.exitReported = false
    this.outputExpired = false
    this.callbackSettlement = undefined
    this.physicalDrain = undefined
    this.settlement = null
    if (this.activationSignal?.aborted) throw new PtyAdmissionClosed()
    if (ownership) this.ownership = ownership.allocate('native')
    const launch = this.launchWindowsPty({
      file: args.bin, args: args.args, cwd: args.cwd, env: args.env, cols: args.cols, rows: args.rows,
    })
    this.windowsLaunch = launch
    void launch.completion.then(() => {}, (error: unknown) => {
      this.rememberExitFailure(error)
      this.startupCleanup = Promise.reject(error)
      this.observe(this.startupCleanup)
    })
    void launch.ready.then((ownedPty) => {
      if (this.windowsLaunch !== launch) return
      const pty = ownedPty as PtyProcess
      this.pty = pty
      pty.onData((data) => {
        if (this.pty === pty && !this.exitFailure) for (const cb of this.dataCbs) cb(data)
      })
      pty.onExit((event) => {
        if (this.pty !== pty || this.exitReported) return
        this.exitReported = true
        this.beginDrain()
        this.callbackSettlement = (async () => {
          await launch.completion
          if (this.exitFailure) throw this.exitFailure.cause
          const exit: AgentExit = { exitCode: event.exitCode, signal: event.signal }
          for (const cb of this.exitCbs) await bounded(Promise.resolve(cb(exit)), `PTY ${pty.pid} exit callbacks`)
          this.ownership?.retire()
          this.pty = null
          this.windowsLaunch = undefined
          this.closedCb?.()
        })().catch((error: unknown) => { throw this.rememberExitFailure(error) })
        this.observeExit(this.callbackSettlement)
        this.notifyPublicExit?.()
      })
      this.supervision = { drain: () => launch.completion }
    }).catch((error: unknown) => {
      for (const cb of this.dataCbs) cb(`\\r\\n[agent] Windows PTY startup failed: ${String(error)}\\r\\n`)
      this.rememberExitFailure(error)
    })
  }

  private failed(error: unknown): void {
    try {
      this.ownership?.fail(error)
    } catch (recordError) {
      console.error('[agent-pty] Could not persist ownership failure:', recordError)
    }
  }

  private observe(work: Promise<void>): void {
    void work.catch((error: unknown) => this.failed(error))
  }

  private rememberExitFailure(error: unknown): unknown {
    if (!this.exitFailure) {
      this.exitFailure = { cause: error }
      this.failed(error)
    } else if (!Object.is(this.exitFailure.cause, error)) {
      console.error('[agent-pty] Additional teardown failure:', error)
    }
    return this.exitFailure.cause
  }

  private observeExit(work: Promise<void>): void {
    void work.catch(() => {
      const notify = this.abandonedCb
      if (!notify || !this.physicalDrain) return
      this.abandonedCb = undefined
      // Observation cannot replace the exit failure or infer proof from it.
      void this.physicalDrain
        .then(notify, () => {})
        .catch((error: unknown) => {
          this.rememberExitFailure(error)
        })
    })
  }

  private beginDrain(): void {
    if (this.draining) return
    this.draining = true
    try {
      this.fence?.beginCallerFinalization()
    } catch (error) {
      this.rememberExitFailure(error)
    }
    // Call into the lease now, even after a caller failure. Before GO this
    // synchronously closes admission. A rejection cannot stand in for proof.
    if (this.supervision) {
      try {
        this.physicalDrain = this.supervision.drain().catch((error: unknown) => {
          throw this.rememberExitFailure(error)
        })
      } catch (error) {
        this.physicalDrain = Promise.reject(this.rememberExitFailure(error))
      }
      void this.physicalDrain.catch(() => {})
    }
    for (const cb of this.drainingCbs) {
      try {
        cb(this.physicalDrain)
      } catch (error) {
        this.rememberExitFailure(error)
      }
    }
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
    if (this.windowsLaunch && !this.pty) {
      const launch = this.windowsLaunch
      const pending = launch.stop().then(() => launch.completion)
      this.settlement = pending
      this.observeExit(pending)
      return pending
    }
    if (this.settlement !== null) return this.settlement
    if (this.callbackSettlement) return this.callbackSettlement
    const pty = this.pty
    if (!pty) return Promise.resolve()
    if (this.supervision) return this.settleOwnedExit(pty)
    this.beginDrain()
    const pending = this.waitForExit(pty)
    this.settlement = pending
    this.observeExit(pending)
    return pending
  }

  private settleOwnedExit(pty: PtyProcess): Promise<void> {
    if (this.settlement !== null) return this.settlement
    // Publish before notifying draining observers, which can reenter Stop.
    // Start the lease synchronously, not in the wait's first microtask.
    const pending = Promise.resolve().then(() => this.waitForExit(pty))
    this.settlement = pending
    this.observeExit(pending)
    this.beginDrain()
    return pending
  }

  private async waitForExit(pty: PtyProcess): Promise<void> {
    // The lease owns the physical deadline. A PTY output timer never runs
    // while that proof is pending, even if the caller phase already failed.
    if (this.physicalDrain) await this.physicalDrain
    if (this.callbackSettlement) return this.callbackSettlement

    const exited = new Promise<void>((resolve, reject) => {
      this.notifyPublicExit = resolve
      this.exitBackstop = setTimeout(() => {
        // A late output edge must not retire a failed POSIX owner. Legacy
        // unsupervised terminals can still present their eventual exit.
        const error = new Error(
          `PTY ${pty.pid} did not report process exit before teardown timed out.`,
        )
        if (this.supervision) this.outputExpired = true
        reject(this.supervision || this.exitFailure ? this.rememberExitFailure(error) : error)
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
    return this.callbackSettlement
  }

  /** Only for the compatibility path. Never infer native POSIX signal
   * authority from a PTY object or a recycled numeric PID. */
  private signal(pty: PtyProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
    if (this.pty !== pty || this.exitReported) return

    signalPty(pty, signal, this.probePid, this.platform, this.taskkill)
  }
}
