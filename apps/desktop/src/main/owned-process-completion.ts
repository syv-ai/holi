import type { ChildProcess } from 'node:child_process'
import type { Duplex } from 'node:stream'
import {
  createOwnedProtocol,
  type LaunchMode,
  type OwnedProcessMessage,
  type OwnedProcessSignal,
} from './owned-process-protocol'

type NativeCompletion = 'empty' | 'handoff'
export type PrivateCompletion = NativeCompletion | 'not-started'
/** Native fixture view, not a plugin contract. @public */
export type PrivateManagedOwnedChild = ChildProcess & {
  readonly ownedCompletion?: Promise<PrivateCompletion>
}

type Setup = Extract<OwnedProcessMessage, { type: 'setup' }>
type Terminal = Extract<OwnedProcessMessage, { type: NativeCompletion }>

interface CompletionOptions {
  launchId: string
  secret: Buffer
  parentPid: number
  helperPid: number
  mode: LaunchMode
  child: ChildProcess
  killHelper: (signal: NodeJS.Signals) => boolean
  control: Duplex
  setupTimeoutMs?: number
  stopTimeoutMs?: number
  partialTimeoutMs?: number
  terminalTimeoutMs?: number
  onSetup?: (message: Setup) => void
  beforeAuth?: (hello: Extract<OwnedProcessMessage, { type: 'hello' }>) => void
  pauseAuthForTest?: (hello: Extract<OwnedProcessMessage, { type: 'hello' }>) => Promise<void>
  onFailure?: (error: Error) => void
  onPhase?: (
    message: Extract<OwnedProcessMessage, { type: 'phase' | 'root-created' | 'root-exit' }>,
  ) => void
  onReady?: () => void
  onOutputFailure?: (error: Error) => void
}

/** Authentication, admission and proof are distinct. Keep stable-handle teardown
 * alive even if proof has already rejected and the caller stopped reading output. */
export function manageOwnedCompletion(options: CompletionOptions) {
  const protocol = createOwnedProtocol({ ...options, role: 'parent' })
  const { control, child, mode } = options
  let phase: 'hello' | 'auth-pending' | 'setup' | 'runtime' = 'hello'
  let parentBirth: string | undefined
  let root: { pid: number; exitCode?: number } | undefined
  let ready = false
  let acknowledged = false
  let stopRequested: OwnedProcessSignal | undefined
  let registrationStopped = false
  let terminal: Terminal | undefined
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined
  let eof = false
  let failed = false
  let settled = false
  let setupTimer: NodeJS.Timeout | undefined
  let finishTimer: NodeJS.Timeout | undefined
  let partialTimer: NodeJS.Timeout | undefined
  let stopTimer: NodeJS.Timeout | undefined
  let resolve!: (value: NativeCompletion) => void
  let reject!: (error: Error) => void
  const completion = new Promise<NativeCompletion>((res, rej) => {
    resolve = res
    reject = rej
  })
  void completion.catch(() => undefined)

  function send(message: OwnedProcessMessage) {
    control.write(protocol.encode(message))
  }
  function release() {
    for (const timer of [setupTimer, finishTimer, partialTimer, stopTimer]) clearTimeout(timer)
    control.off('data', onData)
    control.off('end', onEnd)
    child.off('exit', onExit)
    control.destroy()
  }
  function fail(error: Error, disconnect = false) {
    if (settled || failed) return
    failed = true
    for (const timer of [setupTimer, finishTimer, partialTimer]) clearTimeout(timer)
    reject(error)
    options.onFailure?.(error)
    if (exit || disconnect) return release()
    armStop()
    if (
      phase !== 'hello' &&
      phase !== 'auth-pending' &&
      !stopRequested &&
      !terminal &&
      !control.destroyed
    ) {
      try {
        send({ type: 'stop', signal: 'SIGKILL' })
      } catch {
        /* stable-handle fallback */
      }
    }
  }
  function armStop() {
    if (exit || stopTimer) return
    stopTimer = setTimeout(() => {
      fail(new Error('owned helper stop timed out'))
      try {
        if (options.killHelper('SIGKILL')) return
      } catch {
        /* fall back to control EOF */
      }
      control.destroy()
    }, options.stopTimeoutMs ?? 5000).unref()
  }
  function armFinish() {
    finishTimer ??= setTimeout(
      () => fail(new Error('owned helper completion timed out')),
      options.terminalTimeoutMs ?? 5000,
    ).unref()
  }
  function advance() {
    if (failed || !terminal || !eof || !exit) return
    // Windows process exit is a DWORD, although some adapters expose its signed view.
    if (
      exit.signal !== null ||
      exit.code === null ||
      !Number.isInteger(exit.code) ||
      exit.code < -0x80000000 ||
      exit.code > 0xffffffff ||
      exit.code >>> 0 !== terminal.exitCode
    ) {
      fail(new Error('owned helper exit contradicts authenticated terminal record'))
      return
    }
    settled = true
    release()
    resolve(terminal.type)
  }
  function receive(message: OwnedProcessMessage) {
    if (phase === 'hello') {
      if (
        message.type !== 'hello' ||
        message.helperPid !== options.helperPid ||
        message.parentPid !== options.parentPid
      )
        throw new Error('owned helper identity mismatch')
      const auth = protocol.encode({
        type: 'auth',
        helperPid: options.helperPid,
        parentPid: options.parentPid,
        mode,
      })
      const hello = message
      function authenticate() {
        options.beforeAuth?.(hello)
        parentBirth = hello.parentBirth
        phase = 'setup'
        control.write(auth)
      }
      const pause = options.pauseAuthForTest?.(hello)
      if (pause) {
        phase = 'auth-pending'
        void pause
          .then(() => {
            if (!failed && !settled && !exit && !control.destroyed) authenticate()
          })
          .catch((error: Error) => fail(error))
      } else authenticate()
      return
    }
    if (phase === 'auth-pending') throw new Error('unexpected record before AUTH')
    if (terminal) throw new Error('unexpected record after owned terminal')
    if (message.type === 'error') throw new Error(`owned helper reported ${message.code}`)
    if (phase === 'setup') {
      if (message.type !== 'setup' || message.mode !== mode || message.parentBirth !== parentBirth)
        throw new Error('invalid owned setup confirmation')
      options.onSetup?.(message)
      if (failed) return
      const { mode: _mode, parentBirth: _birth, ...binding } = message
      phase = 'runtime'
      clearTimeout(setupTimer)
      // Snapshot after synchronous SETUP adoption. REGISTERED itself spends
      // admission, so any queued STOP must travel in that same write.
      const stop = stopRequested ?? null
      registrationStopped = stop !== null
      send({ ...binding, type: 'registered', stop })
      return
    }
    if (message.type === 'root-created') {
      if (registrationStopped) throw new Error('owned root created after stopped registration')
      if (root) throw new Error('duplicate owned root creation record')
      root = { pid: message.rootPid }
    } else if (message.type === 'root-exit') {
      if (!root || root.pid !== message.rootPid || root.exitCode !== undefined)
        throw new Error('contradictory owned root exit record')
      root.exitCode = message.rootExitCode
    } else if (message.type === 'phase') {
      // Diagnostics never create or complete root history.
      if ((root?.pid ?? null) !== message.rootPid || root?.exitCode !== undefined)
        throw new Error('contradictory owned root diagnostic')
    } else if (message.type === 'ready') {
      if (mode !== 'retained' || ready || root?.exitCode !== 0)
        throw new Error('unexpected owned READY')
      ready = true
      options.onReady?.()
      return
    } else {
      if (message.type !== 'empty' && message.type !== 'handoff')
        throw new Error('unexpected owned control message')
      const matchedRoot = root
        ? root.pid === message.rootPid && root.exitCode === message.rootExitCode
        : message.rootPid === null && message.rootExitCode === null
      if (!matchedRoot) throw new Error('owned terminal contradicts root history')
      if (message.type === 'handoff') {
        // A locally sent STOP can race a terminal already in flight. The lease
        // still gives STOP priority over native commit authorization.
        if (mode !== 'retained' || !acknowledged) throw new Error('unacknowledged owned HANDOFF')
      } else {
        const valid =
          message.reason === 'natural'
            ? root !== undefined && root.exitCode === message.exitCode && !ready
            : message.reason === 'stopped'
              ? stopRequested !== undefined && message.exitCode === 1
              : root === undefined && message.exitCode === 125
        if (
          !valid ||
          (registrationStopped && message.reason !== 'stopped') ||
          (message.outputFailed && (mode !== 'retained' || !root || ready))
        )
          throw new Error('contradictory owned EMPTY record')
      }
      terminal = message
      armFinish()
      if (message.type === 'empty' && message.outputFailed)
        options.onOutputFailure?.(new Error('owned output relay failed to settle'))
      return
    }
    options.onPhase?.(message)
  }
  function onData(chunk: Buffer) {
    if (failed) return
    try {
      const messages = protocol.push(chunk)
      // A completed frame resets only its own partial deadline; more bytes of
      // the same unfinished frame do not buy another grace period.
      if (messages.length) {
        clearTimeout(partialTimer)
        partialTimer = undefined
      }
      if (protocol.partial)
        partialTimer ??= setTimeout(
          () => fail(new Error('owned control partial frame timed out')),
          options.partialTimeoutMs ?? 5000,
        ).unref()
      for (const message of messages) {
        if (failed) break
        receive(message)
      }
    } catch (error) {
      fail(error as Error)
    }
  }
  function onEnd() {
    if (failed) return
    try {
      protocol.finish()
      if (!terminal) throw new Error('owned control ended without terminal receipt')
      eof = true
      advance()
    } catch (error) {
      fail(error as Error)
    }
  }
  function onExit(code: number | null, signal: NodeJS.Signals | null) {
    exit = { code, signal }
    clearTimeout(stopTimer)
    if (failed) release()
    else if (code === null || signal !== null) fail(new Error('owned helper exited abnormally'))
    else {
      armFinish()
      advance()
    }
  }
  child.once('exit', onExit)
  const onError = (error: Error) => fail(error)
  control.on('error', onError)
  control.on('end', onEnd)
  control.once('close', () => {
    control.off('error', onError)
    if (!eof) fail(new Error('owned control closed before transcript completion'))
  })
  setupTimer = setTimeout(
    () => fail(new Error('owned helper setup timed out')),
    options.setupTimeoutMs ?? 15_000,
  ).unref()
  control.on('data', onData)

  return {
    completion,
    acknowledgeSuccess() {
      if (!ready || acknowledged || stopRequested || terminal || exit || failed) return false
      try {
        send({ type: 'acknowledge' })
        acknowledged = true
        return true
      } catch (error) {
        fail(error as Error)
        return false
      }
    },
    stop(signal: NodeJS.Signals | number = 'SIGTERM') {
      if (failed || settled || exit || terminal) return false
      if (stopRequested) return true
      stopRequested = normalizeSignal(signal)
      armStop()
      if (phase === 'runtime') {
        try {
          send({ type: 'stop', signal: stopRequested })
        } catch (error) {
          fail(error as Error)
        }
      }
      return true
    },
    abort: onError,
    disconnect(error: Error) {
      if (failed || settled) release()
      else fail(error, true)
    },
  }
}

function normalizeSignal(signal: NodeJS.Signals | number): OwnedProcessSignal {
  if (typeof signal === 'number')
    return signal === 9 ? 'SIGKILL' : signal === 2 ? 'SIGINT' : 'SIGTERM'
  if (
    signal === 'SIGTERM' ||
    signal === 'SIGKILL' ||
    signal === 'SIGINT' ||
    signal === 'SIGHUP' ||
    signal === 'SIGQUIT'
  )
    return signal
  throw new Error('unsupported owned-process signal')
}
