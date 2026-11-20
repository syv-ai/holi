import type { SpawnOptions } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { constants as osConstants } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { posixLeaseExecutable } from './posix-lease-executable'
import type { ProcessGroupSupervision } from './owned-process-supervision'
import { environmentFrame, invalidReceipt, leaseReceipts, receiptPid } from './posix-lease-protocol'
import { leaseEnvironment, openLeaseTransport } from './posix-lease-transport'

type LaunchOptions = SpawnOptions & {
  startupTimeoutMs?: number
  graceMs?: number
  timeoutMs?: number
  pollMs?: number
  directory?: string
}
type CancelState = 'unlaunched' | 'possibly-launched'
type StartupPhase =
  | 'root'
  | 'environment'
  | 'reaper'
  | 'rack'
  | 'anchor'
  | 'ready'
  | 'start-sent'
  | 'started'
  | 'go-sent'
  | 'committed'

const code = (error: unknown) => (error as NodeJS.ErrnoException).code

function absent(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if (code(error) === 'ESRCH') return true
    if (code(error) === 'EPERM') return false
    throw error
  }
}

function milliseconds(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff)
    throw new RangeError('Invalid POSIX launch deadline.')
  return value
}

export type PosixLaunch = Pick<
  ReturnType<typeof prepare>,
  'executable' | 'args' | 'options' | 'bind' | 'cancel' | 'drain'
>

/** Node-pty adapter: launch exactly once with the returned executable/args and
 * private env, then bind the native PID or cancel with the native outcome. */
export function preparePosixLaunch(
  file: string,
  args: string[],
  options: LaunchOptions,
): PosixLaunch {
  const {
    executable,
    args: argv,
    options: launchOptions,
    bind,
    cancel,
    drain,
  } = prepare(file, args, options)
  return { executable, args: argv, options: launchOptions, bind, cancel, drain }
}

/** ChildProcess adapter: inherited descriptors work even with uid/gid options. */
export function preparePosixSpawn(
  file: string,
  args: string[],
  options: SpawnOptions,
  stdio: NonNullable<Exclude<SpawnOptions['stdio'], string>>,
) {
  return prepare(file, args, options, stdio)
}

function prepare(
  file: string,
  args: string[],
  options: LaunchOptions,
  stdio?: NonNullable<Exclude<SpawnOptions['stdio'], string>>,
) {
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new Error('POSIX launch leases require macOS or Linux.')
  if (
    typeof file !== 'string' ||
    !file ||
    [file, ...args].some((arg) => typeof arg !== 'string' || arg.includes('\0'))
  )
    throw new TypeError('Invalid POSIX launch command.')
  const executable = posixLeaseExecutable()
  accessSync(executable, constants.X_OK)
  const startupMs = milliseconds(options.startupTimeoutMs ?? 5000)
  const grace = milliseconds(options.graceMs ?? 1500)
  const timeout = milliseconds((stdio ? undefined : options.timeoutMs) ?? 15_000)
  const poll = milliseconds(options.pollMs ?? 10)
  let payload: Buffer | undefined = environmentFrame(options, stdio !== undefined)
  const transport = openLeaseTransport(options.directory, stdio !== undefined)
  const receipts = leaseReceipts(transport)

  const stagingDeadline = performance.now() + startupMs
  let bound: number | undefined
  let root: number | undefined
  let wrong: number | undefined
  let reaper: number | undefined
  let anchor: number | undefined
  let phase: StartupPhase = 'root'
  let deadlineLimit = stagingDeadline
  let canceled = false
  let term = false
  let kill = false
  let requestedStop: Promise<void> | undefined
  const pendingSignals: Array<{ sig: number }> = []
  let acceptedStop: 'T' | 'K' | undefined
  let firstError: unknown
  let startup: Promise<void> | undefined
  let drainPromise: Promise<void> | undefined
  let cancelling: Promise<void> | undefined
  const note = (error: unknown) => {
    firstError ??= error
  }

  const collect = () =>
    receipts.collect((receipt, line) => {
      const { kind } = receipt
      if (phase === 'root' && !wrong && (kind === 'ROOT' || kind === 'WRONG')) {
        if (kind === 'WRONG') {
          wrong = receipt.pid
          throw new Error('POSIX launch did not create a private session/group.')
        }
        root = receipt.pid
        phase = 'environment'
        if (bound !== undefined && root !== bound)
          throw new Error('POSIX launch root PID mismatch.')
      } else if (phase === 'reaper' && kind === 'REAPER') {
        if (receipt.pid === root) throw new Error('Invalid POSIX launch reaper.')
        reaper = receipt.pid // Retain authority before sending RACK, even on startup failure.
        phase = 'rack'
      } else if (phase === 'anchor' && kind === 'READY') {
        if (receipt.anchor === root || receipt.anchor === reaper || receipt.reaper !== reaper)
          throw new Error('Invalid POSIX launch anchor.')
        anchor = receipt.anchor
        phase = 'ready'
      } else if (kind === 'START' && phase === 'start-sent' && !term && !kill) phase = 'started'
      else if (kind === 'GO' && phase === 'go-sent' && !term && !kill) phase = 'committed'
      else if (
        kind === 'SIGNAL' &&
        phase === 'committed' &&
        !term &&
        !kill &&
        receipt.sig === pendingSignals[0]?.sig
      )
        pendingSignals.shift()
      else if (kind === 'TERM' && anchor && !term && !kill) term = true
      else if (kind === 'KILL' && anchor && !kill) kill = true
      else if (kind === 'ERROR' && root) note(receipt.failure)
      else throw invalidReceipt(line)
    }, note)

  function execution(): number | null | undefined {
    collect()
    if (firstError) throw firstError
    // Before commit an EOF is startup failure, not exec completion.
    if (phase === 'committed') return receipts.execution()
  }

  const pause = (deadline: number) =>
    delay(Math.min(poll, Math.max(0, deadline - performance.now())))
  async function wait<T>(
    deadline: number,
    label: string,
    test: () => T | undefined,
    ignoreError = false,
    startupCheck = false,
  ): Promise<T> {
    for (;;) {
      if (startupCheck && canceled) throw new Error('POSIX launch was cancelled before start.')
      collect()
      if (!ignoreError && firstError) throw firstError
      const value = test()
      if (value !== undefined) return value
      const end = startupCheck ? Math.min(deadline, deadlineLimit) : deadline
      if (performance.now() >= end) throw new Error(`Timed out ${label}.`)
      await pause(end)
    }
  }

  function proveAbsent(): true | undefined {
    // First join the reaper: it can still fork an anchor and join it to the
    // root group. An unacknowledged reaper cannot leave that group at all.
    if (reaper !== undefined && (!absent(reaper) || !absent(-reaper))) return
    if (anchor !== undefined && !absent(anchor)) return
    if (root !== undefined && (!absent(root) || !absent(-root))) return
    if (wrong !== undefined && !absent(wrong)) return
    if (
      bound !== undefined &&
      bound !== root &&
      bound !== wrong &&
      (!absent(bound) || !absent(-bound))
    )
      return
    if (root === undefined && wrong === undefined && bound === undefined) return
    // A named FIFO can look closed before startup. Only accept a fresh EOF
    // after kernel absence; if there are more records, prove again with the
    // resulting identities and protocol state, including on the error path.
    if (collect()) return true
  }

  async function finish(deadline: number, checkReceipts: boolean) {
    try {
      await wait(deadline, 'proving the POSIX launch absent', proveAbsent)
      if (firstError) throw firstError
      if (checkReceipts && (!kill || (!term && acceptedStop !== 'K')))
        throw new Error('POSIX launch group vanished without the expected teardown receipts.')
      transport.remove()
    } catch (error) {
      note(error)
      // EOF is an independent wakeup, not a replacement for the first error.
      try {
        closeControl()
        await wait(deadline, 'joining POSIX launch fallback', proveAbsent, true)
        transport.remove()
      } catch {
        if (firstError instanceof Error && Object.isExtensible(firstError))
          Object.assign(firstError, { evidenceDirectory: transport.directory })
        try {
          transport.retainFailure(
            [
              bound,
              receipts.history(),
              String(firstError),
              `root=${root} reaper=${reaper} anchor=${anchor}`,
            ].join('\n'),
          )
        } catch {
          /* original failure wins */
        }
      }
      throw firstError
    }
  }

  function drain(): Promise<void> {
    if (cancelling) return cancelling
    if (!startup) throw new Error('Bind or cancel the POSIX launch before draining it.')
    return (drainPromise ??= (async () => {
      const deadline = performance.now() + timeout
      deadlineLimit = Math.min(deadlineLimit, deadline)
      try {
        await startup
        await requestedStop
        if (bound !== undefined) absent(-bound) // Preflight is read-only; it is never the final proof.
        if (!acceptedStop) {
          await wait(deadline, 'sending POSIX teardown', () => {
            if (transport.post(Buffer.from('T')) === 1) {
              acceptedStop = 'T'
              return true
            }
          })
        }
      } catch (error) {
        note(error)
      }
      await finish(deadline, true)
    })())
  }

  function closeControl() {
    try {
      transport.closeControl()
    } catch (error) {
      note(error)
    }
  }

  function cancel(state: CancelState): Promise<void> {
    if (drainPromise) return drainPromise
    return (cancelling ??= (async () => {
      if (startup && state === 'unlaunched')
        throw new Error('Cannot cancel a bound launch as unlaunched.')
      canceled = true
      payload = undefined
      try {
        transport.dropMapped()
      } catch (error) {
        note(error)
      }
      closeControl()
      if (state === 'unlaunched') {
        transport.remove()
        if (firstError) throw firstError
        return
      }
      // Never infer absence from a missing startup receipt. A native call
      // that threw may already have forked, or not even have entered exec.
      await finish(performance.now() + timeout, false)
    })())
  }

  return {
    executable,
    args: [
      String(stdio?.length ?? 0),
      stdio ? '-' : transport.directory,
      String(startupMs),
      String(grace),
      file,
      options.argv0 ?? file,
      ...args,
    ],
    options: {
      ...options,
      env: { ...leaseEnvironment },
      shell: false,
      argv0: undefined,
      detached: true as const,
      stdio: stdio ? [...stdio, ...transport.mapped] : options.stdio,
    },
    bind(rootPid: number): Promise<ProcessGroupSupervision> {
      if (startup || cancelling) throw new Error('POSIX launch has already been claimed.')
      bound = receiptPid(String(rootPid))
      const stage = <T>(label: string, test: () => T | undefined) =>
        wait(stagingDeadline, label, test, false, true)
      startup = (async () => {
        transport.dropMapped()
        await stage('waiting for POSIX launch root', () => root)
        let offset = 0
        const frame = payload!
        await stage('sending the POSIX provider environment', () => {
          offset += transport.post(frame, offset)
          if (offset === frame.length) {
            phase = 'reaper'
            return true
          }
        })
        payload = undefined
        const send = (label: string, byte: string, next: StartupPhase) => {
          const frame = Buffer.from(byte)
          return stage(label, () => {
            if (transport.post(frame) !== 1) return
            phase = next
            return true
          })
        }
        await stage('waiting for POSIX reaper identity', () => phase === 'rack' || undefined)
        await send('acknowledging POSIX reaper ownership', 'A', 'anchor')
        await stage('waiting for POSIX anchor readiness', () => phase === 'ready' || undefined)
        await send('sending POSIX START', 'S', 'start-sent')
        await stage(
          'waiting for POSIX START acknowledgement',
          () => phase === 'started' || undefined,
        )
        await send('committing POSIX exec', 'G', 'go-sent')
        await stage('waiting for POSIX launch commit', () => phase === 'committed' || undefined)
      })()
      const binding = startup.then(() => ({ drain }))
      void binding.catch((error) => {
        if (canceled) return
        note(error)
        void drain().catch(() => {})
      })
      return binding
    },
    drain,
    cancel,
    failExecution(error: unknown): Promise<void> {
      note(error)
      // Cancellation may race an owner already joining drain. Wake the
      // native anchor without replacing that promise or its first error.
      if (drainPromise) {
        closeControl()
        return drainPromise
      }
      return cancel('possibly-launched')
    },
    execution,
    waitForExecution: () => wait(stagingDeadline, 'confirming POSIX exec', execution),
    signal(sig: number): boolean {
      if (!bound) return false
      if (sig === 0) return !absent(-bound)
      if (
        transport.controlClosed() ||
        requestedStop ||
        drainPromise ||
        !Number.isInteger(sig) ||
        sig < 1 ||
        sig > 127
      )
        return false
      const { SIGTERM, SIGKILL } = osConstants.signals
      const command = sig === SIGTERM ? 'T' : sig === SIGKILL ? 'K' : undefined
      const deadline = performance.now() + timeout
      const sent = startup!.then(async () => {
        const frame = command ? Buffer.from(command) : Buffer.from([70, sig])
        await wait(
          deadline,
          'sending POSIX signal',
          () => transport.post(frame) === frame.length || undefined,
        )
        if (command) acceptedStop = command
        else {
          const pendingSignal = { sig }
          pendingSignals.push(pendingSignal)
          await wait(
            deadline,
            'waiting for POSIX signal acknowledgement',
            () => !pendingSignals.includes(pendingSignal) || undefined,
          )
        }
      })
      if (command) requestedStop = sent
      void sent.catch((error: unknown) => {
        note(error)
        void drain().catch(() => {})
      })
      return true
    },
  }
}
