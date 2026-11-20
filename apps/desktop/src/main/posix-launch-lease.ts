import type { SpawnOptions } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { constants as osConstants } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { posixLeaseExecutable } from './posix-lease-executable'
import type { ProcessGroupSupervision } from './owned-process-supervision'
import { environmentFrame, invalidReceipt, leaseReceipts, receiptPid } from './posix-lease-protocol'
import { leaseEnvironment, openLeaseTransport } from './posix-lease-transport'
import {
  markPosixNonAdmission,
  openPosixOwnershipJournal,
  posixAbsent as absent,
  posixLaunchNonAdmission,
} from './posix-ownership-journal'

type OwnershipRecord = ReturnType<typeof openPosixOwnershipJournal>

type LaunchOptions = SpawnOptions & {
  startupTimeoutMs?: number
  graceMs?: number
  timeoutMs?: number
  pollMs?: number
  directory?: string
  ownershipRecordPath?: string
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

function prepareOwned<T>(path: string | undefined, build: (record: OwnershipRecord) => T): T {
  let record: OwnershipRecord
  try {
    record = openPosixOwnershipJournal(path)
    return build(record)
  } catch (error) {
    const cleanup = Promise.resolve(posixLaunchNonAdmission(error)?.cleanup)
      .then(async () => {
        if (path !== undefined && !record) throw error
        record?.settle()
      })
      .catch((failure: unknown) => {
        try {
          record?.fail('preparation')
        } catch {
          /* preserve the cleanup failure */
        }
        throw failure
      })
    markPosixNonAdmission(error, cleanup)
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
  } = prepareOwned(options.ownershipRecordPath, (record) => prepare(file, args, options, record))
  return { executable, args: argv, options: launchOptions, bind, cancel, drain }
}

/** ChildProcess adapter: inherited descriptors work even with uid/gid options. */
export function preparePosixSpawn(
  file: string,
  args: string[],
  options: LaunchOptions,
  stdio: NonNullable<Exclude<SpawnOptions['stdio'], string>>,
) {
  return prepareOwned(options.ownershipRecordPath, (record) =>
    prepare(file, args, options, record, stdio),
  )
}

export function refusePosixSpawnPreparation(path: string | undefined, error: unknown): never {
  markPosixNonAdmission(
    error,
    Promise.resolve().then(() => openPosixOwnershipJournal(path)?.settle()),
  )
  throw error
}

function prepare(
  file: string,
  args: string[],
  options: LaunchOptions,
  record: OwnershipRecord,
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
  const transport = openLeaseTransport(options.directory, stdio !== undefined, record?.journal)
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
  let goWritten = false
  const startupStop = new Error('POSIX launch was cancelled before start.')
  const startupWake = new AbortController()
  let term = false
  let kill = false
  let requestedStop: Promise<void> | undefined
  const pendingSignals: Array<{ sig: number }> = []
  let acceptedStop: 'T' | 'K' | undefined
  let firstError: unknown
  let startup: Promise<void> | undefined
  let drainPromise: Promise<void> | undefined
  let cancelling: Promise<void> | undefined
  const note = (
    error: unknown,
    stage: 'protocol' | 'drain' | 'cancel' | 'settlement' = 'protocol',
  ) => {
    if (firstError !== undefined) return
    firstError = error
    try {
      record?.fail(stage)
    } catch {
      // Preserve the original live failure; a partial disk record is not proof.
    }
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

  async function wait<T>(
    deadline: number,
    label: string,
    test: () => T | undefined,
    ignoreError = false,
    startupCheck = false,
  ): Promise<T> {
    for (;;) {
      if (startupCheck && canceled) throw startupStop
      collect()
      if (!ignoreError && firstError) throw firstError
      const value = test()
      if (value !== undefined) return value
      const end = startupCheck ? Math.min(deadline, deadlineLimit) : deadline
      if (performance.now() >= end) throw new Error(`Timed out ${label}.`)
      try {
        await delay(
          Math.min(poll, Math.max(0, end - performance.now())),
          undefined,
          startupCheck ? { signal: startupWake.signal } : undefined,
        )
      } catch (error) {
        if (startupCheck && (error as Error | undefined)?.cause === startupStop) throw startupStop
        throw error
      }
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

  function settle() {
    record?.settle()
    transport.remove()
  }

  async function finish(deadline: number, checkReceipts: boolean) {
    try {
      await wait(deadline, 'proving the POSIX launch absent', proveAbsent)
      if (firstError) throw firstError
      if (checkReceipts && (!kill || (!term && acceptedStop !== 'K')))
        throw new Error('POSIX launch group vanished without the expected teardown receipts.')
      settle()
    } catch (error) {
      note(error, 'drain')
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
    // A physical stop before the GO write closes admission in this turn,
    // rather than waiting for startup to admit the provider and then sending T.
    if (!goWritten) return cancel('possibly-launched')
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
        note(error, 'drain')
      }
      await finish(deadline, true)
    })())
  }

  function closeControl() {
    try {
      transport.closeControl()
    } catch (error) {
      note(error, 'cancel')
    }
  }

  function closeAdmission() {
    canceled = true
    payload = undefined
    try {
      transport.dropMapped()
    } catch (error) {
      note(error, 'cancel')
    }
    closeControl()
    startupWake.abort(startupStop)
  }

  function cancel(state: CancelState): Promise<void> {
    if (drainPromise) return drainPromise
    return (cancelling ??= (async () => {
      if (startup && state === 'unlaunched')
        throw new Error('Cannot cancel a bound launch as unlaunched.')
      closeAdmission()
      if (state === 'unlaunched') {
        if (firstError) throw firstError
        try {
          settle()
        } catch (error) {
          note(error, 'settlement')
          throw error
        }
        return
      }
      // Never infer absence from a missing startup receipt. A native call
      // that threw may already have forked, or not even have entered exec.
      const deadline = performance.now() + timeout
      // Join the interrupted startup before inspecting absence, so an actual
      // staging error that raced the stop stays sticky. This is the raw startup
      // promise, not bind's result, which may itself wait for this cleanup.
      if (!goWritten) await startup?.catch(() => {})
      await finish(deadline, false)
    })())
  }

  return {
    executable,
    args: [
      String(stdio?.length ?? 0),
      stdio ? '-' : transport.directory,
      String(startupMs),
      String(grace),
      record ? (stdio ? '1' : record.journal) : '0',
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
            // Writing GO, not reading its acknowledgement, is the admission
            // linearization point: the anchor may open exec as soon as it reads G.
            if (next === 'go-sent') goWritten = true
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
      })().catch((error: unknown) => {
        if (error !== startupStop) note(error)
        throw error
      })
      const binding = startup.then(
        () => ({ drain }),
        async (error: unknown) => {
          const cleanup = drain()
          void cleanup.catch(() => {})
          if (error === startupStop && !goWritten) {
            await cleanup
            markPosixNonAdmission(error, cleanup)
          }
          throw error
        },
      )
      void binding.catch(() => {})
      return binding
    },
    drain,
    cancel,
    abortBeforeCommit(): boolean {
      if (goWritten) return false
      void drain().catch(() => {})
      return true
    },
    canceledBeforeCommit: () => canceled && !goWritten,
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
        if (error === startupStop) return
        note(error)
        void drain().catch(() => {})
      })
      return true
    },
  }
}
