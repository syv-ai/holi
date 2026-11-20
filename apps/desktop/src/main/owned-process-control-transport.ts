import type { ChildProcess } from 'node:child_process'
import { connect, type Socket } from 'node:net'
import { manageOwnedCompletion, type PrivateCompletion } from './owned-process-completion'
import type { LaunchMode, OwnedProcessMessage } from './owned-process-protocol'

type Hello = Extract<OwnedProcessMessage, { type: 'hello' }>
type ControlEvent =
  | Extract<
      OwnedProcessMessage,
      { type: 'hello' | 'setup' | 'phase' | 'root-created' | 'root-exit' }
    >
  | { type: 'ready' }
  | { type: 'output-failure' | 'failure'; error: Error }
  | { type: 'complete'; value: Exclude<PrivateCompletion, 'not-started'> }

/** Owns the private pipe from dialing through physical close. HELLO and SETUP
 * are observed synchronously before the controller writes AUTH and REGISTERED. */
export function ownedControlTransport({
  pipe,
  child,
  launchId,
  secret,
  parentPid,
  mode,
  helperExited,
  killHelper,
  observe,
  pauseAuthForTest,
  dropRegisteredForTest,
}: {
  pipe: string
  child: ChildProcess
  launchId: string
  secret: Buffer
  parentPid: number
  mode: LaunchMode
  helperExited: () => boolean
  killHelper: (signal: NodeJS.Signals) => boolean
  observe: (event: ControlEvent) => void
  pauseAuthForTest?: (hello: Hello) => Promise<void>
  dropRegisteredForTest: boolean
}) {
  const setupUntil = performance.now() + 15_000
  let connectUntil = setupUntil
  let stopUntil: number | undefined
  let queuedStop: NodeJS.Signals | number | undefined
  let connecting = true
  let socket: Socket | undefined
  let retryTimer: NodeJS.Timeout | undefined
  let manager: ReturnType<typeof manageOwnedCompletion> | undefined
  const unclosed = new Set<Promise<void>>()
  let deadline = setTimeout(connectionTimeout, 15_000)
  deadline.unref?.()

  function finishConnecting() {
    connecting = false
    clearTimeout(deadline)
    clearTimeout(retryTimer)
    child.off('spawn', dial)
    child.off('exit', onHelperExit)
    child.off('close', onHelperClose)
    const pending = socket
    socket = undefined
    pending?.destroy()
  }
  function failConnection(error: Error, terminate: boolean) {
    if (!connecting) return
    finishConnecting()
    observe({ type: 'failure', error })
    if (terminate && child.pid !== undefined && !helperExited()) {
      try {
        killHelper('SIGKILL')
      } catch {
        // The helper has its own bounded authentication deadline and kill-on-close job.
      }
    }
  }
  function connectionTimeout() {
    failConnection(
      new Error(
        stopUntil === connectUntil
          ? 'owned helper stop timed out'
          : 'owned control connection timed out',
      ),
      true,
    )
  }
  function onHelperExit() {
    failConnection(new Error('owned helper exited before control authentication'), false)
  }
  function onHelperClose() {
    failConnection(new Error('owned helper closed before control authentication'), false)
  }
  child.once('exit', onHelperExit)
  child.once('close', onHelperClose)

  function dial() {
    if (!connecting || helperExited()) return
    if (performance.now() >= connectUntil) return connectionTimeout()
    const candidate = connect(`\\\\.\\pipe\\${pipe}`)
    socket = candidate
    const closed = new Promise<void>((resolve) => {
      candidate.once('close', () => {
        candidate.off('connect', onConnect)
        candidate.off('error', onConnectError)
        if (socket === candidate) socket = undefined
        unclosed.delete(closed)
        resolve()
      })
    })
    unclosed.add(closed)
    candidate.once('connect', onConnect)
    candidate.on('error', onConnectError)

    function onConnectError(error: Error) {
      if (!connecting || socket !== candidate) return
      socket = undefined
      candidate.destroy()
      if (performance.now() >= connectUntil) return failConnection(error, true)
      retryTimer = setTimeout(dial, 25)
      retryTimer.unref?.()
    }
    function onConnect() {
      if (!connecting || socket !== candidate || helperExited()) {
        candidate.destroy()
        return
      }
      if (performance.now() >= connectUntil) return connectionTimeout()
      // The controller owns I/O and teardown from here. Transport still joins close.
      socket = undefined
      finishConnecting()
      candidate.off('error', onConnectError)
      manager = manageOwnedCompletion({
        launchId,
        secret,
        parentPid,
        helperPid: child.pid!,
        child,
        killHelper,
        control: candidate,
        mode,
        setupTimeoutMs: Math.max(0, setupUntil - performance.now()),
        stopTimeoutMs:
          stopUntil === undefined ? undefined : Math.max(0, stopUntil - performance.now()),
        pauseAuthForTest,
        beforeAuth: observe,
        onSetup: (record) => {
          observe(record)
          if (dropRegisteredForTest) {
            candidate.destroy() // Break control without sending REGISTERED or STOP.
            throw new Error('fixture dropped REGISTERED')
          }
        },
        onPhase: observe,
        onReady: () => observe({ type: 'ready' }),
        onOutputFailure: (error) => observe({ type: 'output-failure', error }),
        onFailure: (error) => observe({ type: 'failure', error }),
      })
      void manager.completion.then(
        (value) => observe({ type: 'complete', value }),
        () => undefined,
      )
      if (queuedStop !== undefined) manager.stop(queuedStop)
    }
  }

  async function joinClose() {
    // Neither a transcript failure nor destroy() proves the socket has closed.
    await Promise.all(unclosed)
  }

  return {
    joinClose,
    connect() {
      if (!connecting) return
      if (child.pid !== undefined) dial()
      else child.once('spawn', dial)
    },
    acknowledge() {
      return manager?.acknowledgeSuccess() ?? false
    },
    stop(signal?: NodeJS.Signals | number) {
      if (manager) return manager.stop(signal)
      if (!connecting || helperExited()) return false
      if (queuedStop === undefined) {
        queuedStop = signal ?? 'SIGTERM'
        stopUntil = performance.now() + 5000
        if (stopUntil < connectUntil) {
          connectUntil = stopUntil
          clearTimeout(deadline)
          deadline = setTimeout(connectionTimeout, 5000)
          deadline.unref?.()
        }
      }
      return true
    },
    abort(error: Error) {
      if (manager) manager.abort(error)
      else failConnection(error, true)
    },
    // Only definitive OS spawn failures can cancel without rejecting proof.
    cancelBeforeSession() {
      if (manager) return false
      finishConnecting()
      return true
    },
    async dispose(error: Error) {
      if (manager) manager.disconnect(error)
      else failConnection(error, false)
      await joinClose()
    },
  }
}
