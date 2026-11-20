import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  ownedProcessDrain,
  posixLaunchNonAdmission,
  spawnOwnedProgram,
  type ProcessGroupSupervision,
} from '../../../../main/plugin-api'
import type { JobRun, JobsProvider } from '../provider'
import { bounded } from './bounded'
import type { JobTurnReceipt } from './job-receipts'

type JobChild = ChildProcess & { [ownedProcessDrain]?: ProcessGroupSupervision }

type SpawnJob = (
  bin: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string> },
) => JobChild

interface TurnOptions {
  id: string
  provider: JobsProvider
  run: JobRun
  receipt: JobTurnReceipt
  spawn?: SpawnJob
  killGraceMs: number
  progress(
    event: { kind: 'thread'; id: string } | { kind: 'turn-completed'; tokens?: number },
  ): void
  onDraining(): void
  rememberFailure(error: unknown): Error
}

interface Output {
  readonly completed: boolean
  readonly refusal?: string
  readonly failure: string
}

/** One turn owns one retained control channel and its output. No provider or
 * file finalizer runs until `output` proves both phases complete. */
export function startJobTurn({
  id,
  provider,
  run,
  receipt,
  spawn,
  killGraceMs,
  progress,
  onDraining,
  rememberFailure,
}: TurnOptions) {
  const windows = process.platform === 'win32'
  const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))
  let child: JobChild | undefined
  let refusal: string | undefined
  let launchError: unknown
  let invoked = false
  let typed: ReturnType<typeof posixLaunchNonAdmission>
  let cleanup: Promise<void> | undefined
  try {
    let path: string | undefined
    try {
      path = receipt.prepare(spawn !== undefined)
    } catch (error) {
      throw rememberFailure(error)
    }
    const command = provider.capabilities.jobs.command(run)
    if (command === null) refusal = provider.notInstalled
    else {
      const options = { cwd: run.cwd, env: command.env }
      const { bin, args } = command
      invoked = true
      child = spawn
        ? spawn(bin, args, options)
        : spawnOwnedProgram(bin, args, {
            ...options,
            stdio: ['ignore', 'pipe', 'pipe'],
            posixGroupLease: true,
            ...(path !== undefined && { ownershipRecordPath: path }),
          })
    }
  } catch (error) {
    launchError = error
    refusal = invoked ? `${provider.label} did not start: ${describe(error)}` : describe(error)
    if (invoked && !windows) {
      typed = posixLaunchNonAdmission(error)
      // Ambiguous throws may still carry a cleanup operation worth joining;
      // its fulfillment alone never proves that launch did not occur.
      const pending = error as { cleanup?: Promise<void>; cleanupPromise?: Promise<void> } | null
      cleanup = typed?.cleanup ?? pending?.cleanup ?? pending?.cleanupPromise
    }
  }

  const group = child?.[ownedProcessDrain]
  const missingLease = child !== undefined && group === undefined && !windows
  const pidWritten = child?.pid === undefined ? undefined : receipt.writePid(child.pid, run.cwd)
  void pidWritten?.catch(rememberFailure)
  let resolveOutput!: (result: Output) => void
  let rejectOutput!: (error: Error) => void
  const output = new Promise<Output>((resolve, reject) => {
    resolveOutput = resolve
    rejectOutput = reject
  })

  const stdout = child?.stdout
  let stdoutEnded = stdout == null
  let stdoutFailure: Error | undefined
  let execObserved = false
  let childClose: { code: number | null; signal: NodeJS.Signals | null } | undefined
  let resolveClose!: () => void
  let rejectClose!: (error: Error) => void
  const closed = new Promise<void>((resolve, reject) => {
    resolveClose = resolve
    rejectClose = reject
  })
  // A broken pipe can report failure before the physical lease settles.
  void closed.catch(() => {})
  function checkClose() {
    if (stdoutFailure !== undefined && !typed) {
      // Before exec, let the core report a typed non-admission before native
      // close. A pipe failure does not poison a proven pre-GO cancellation.
      if (childClose !== undefined || (execObserved && (!windows || group)))
        rejectClose(stdoutFailure)
    } else if (childClose !== undefined && (stdoutEnded || typed)) resolveClose()
  }
  function failStdout(error: Error) {
    if (stdoutEnded || stdoutFailure !== undefined) return
    stdoutFailure = error
    checkClose()
    if (!windows || group) drain()
  }

  let completed = false
  let failure: string | undefined
  let eventError: string | undefined
  let childError: string | undefined
  let stderr = ''
  let draining = false
  let outputFinished = false
  let winTimer: ReturnType<typeof setTimeout> | undefined

  // Register end after readline: its end handler emits the last unterminated
  // line synchronously, and that line belongs to this clean output receipt.
  const lines = stdout == null ? undefined : createInterface({ input: stdout })
  lines?.on('error', failStdout)
  stdout?.on('error', failStdout)
  stdout?.once('end', () => {
    stdoutEnded = true
    checkClose()
  })
  stdout?.once('close', () => failStdout(new Error(`Job ${id} stdout closed before end.`)))
  lines?.on('line', (line) => {
    if (outputFinished || stdoutFailure !== undefined || typed) return
    const event = provider.capabilities.jobs.event(line)
    if (event?.kind === 'thread') progress(event)
    else if (event?.kind === 'turn-completed') {
      completed = true
      progress(event)
    } else if (event?.kind === 'turn-failed') failure = event.message
    else if (event?.kind === 'error') eventError = event.message
  })
  child?.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-4_000)
  })

  function drain(outputMs = 5_000) {
    if (draining) return
    draining = true
    onDraining()
    void (async () => {
      try {
        receipt.phase('FINALIZING')
      } catch (error) {
        rememberFailure(error)
      }
      if (missingLease)
        throw new Error(`Job ${id} has no POSIX launch lease; its owner is unresolved.`)
      // Invoke the lease synchronously: a pre-GO Stop must close admission
      // before any startup continuation can admit the provider.
      if (group) await group.drain()
      await (typed?.cleanup ?? cleanup)
      if (!windows && child === undefined && invoked && !typed) throw launchError
      // Only positive physical proof starts the output deadline. An already
      // known physical error never waits for the pipes or a caller callback.
      try {
        await bounded(Promise.all([closed, pidWritten]), `Output of job ${id}`, outputMs)
      } catch (error) {
        throw typed ? error : (stdoutFailure ?? error)
      }
      if (!invoked || typed) receipt.nonLaunch()
      const { code, signal } = childClose!
      const last = stderr.trim().split('\n').at(-1)?.trim().slice(0, 300) ?? ''
      return {
        completed: completed && code === 0 && failure === undefined && childError === undefined,
        ...(refusal === undefined ? {} : { refusal }),
        failure:
          refusal ??
          childError ??
          failure ??
          eventError ??
          (signal !== null
            ? `${provider.label} was stopped (${signal}).`
            : `${provider.label} exited with code ${code ?? '?'}${last === '' ? '.' : `: ${last}`}`),
      }
    })()
      .finally(() => {
        outputFinished = true
        clearTimeout(winTimer)
        lines?.close()
      })
      .then(resolveOutput, (error: unknown) => rejectOutput(rememberFailure(error)))
  }

  function settle(code: number | null, signal: NodeJS.Signals | null) {
    if (childClose !== undefined) return
    childClose = { code, signal }
    clearTimeout(winTimer)
    checkClose()
    drain()
  }

  let started = child?.pid !== undefined
  child?.once('spawn', () => {
    started = true
    execObserved = true
    checkClose()
    if (!draining) {
      try {
        receipt.phase('ACTIVE')
      } catch (error) {
        rememberFailure(error)
        drain()
      }
    }
  })
  child?.once('exit', () => {
    started = true
    execObserved = true
    checkClose()
    drain()
  })
  child?.once('close', settle)
  child?.on('error', (error) => {
    if (outputFinished) return
    typed ??= windows ? undefined : posixLaunchNonAdmission(error)
    childError ??=
      started && !typed
        ? `${provider.label} process error: ${error.message}`
        : `${provider.label} did not start: ${error.message}`
    if (typed || (!started && windows)) settle(null, null)
    else drain()
  })
  if (missingLease) {
    refusal = rememberFailure(
      new Error(`Job ${id} has no POSIX launch lease; its owner is unresolved.`),
    ).message
    settle(null, null)
  } else if (!child) settle(null, null)

  function signalWindows(sig: 'SIGTERM' | 'SIGKILL') {
    if (child?.pid === undefined || childClose !== undefined) return
    try {
      child.kill(sig)
    } catch {
      /* The owned helper may already have exited. */
    }
  }
  let stopRequested = false
  return {
    refusal,
    bracket: child !== undefined && !missingLease,
    output,
    stop() {
      if (stopRequested) return
      stopRequested = true
      if (windows && !group && childClose === undefined) {
        signalWindows('SIGTERM')
        if (childClose === undefined)
          winTimer = setTimeout(() => signalWindows('SIGKILL'), killGraceMs)
        drain(killGraceMs + 5_000)
      } else drain()
    },
  }
}
