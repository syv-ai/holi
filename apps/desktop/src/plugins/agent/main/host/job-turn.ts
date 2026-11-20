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
  let physical: Promise<void> | undefined
  let closing = false
  let outputDone = false
  let outputFailed = false
  let winTimer: ReturnType<typeof setTimeout> | undefined
  function drain() {
    return (physical ??= (async () => {
      try {
        receipt.phase('FINALIZING')
      } catch (error) {
        rememberFailure(error)
      }
      if (missingLease)
        throw new Error(`Job ${id} has no POSIX launch lease; its owner is unresolved.`)
      if (group) await group.drain()
      await (typed?.cleanup ?? cleanup)
      if (!windows && child === undefined && invoked && !typed) throw launchError
      if (!invoked || typed) receipt.nonLaunch()
    })().catch((error: unknown) => {
      const first = rememberFailure(error)
      failOutput(first)
      throw first
    }))
  }

  let resolveOutput!: (result: Output) => void
  let rejectOutput!: (error: Error) => void
  const output = new Promise<Output>((resolve, reject) => {
    resolveOutput = resolve
    rejectOutput = reject
  })
  function failOutput(error: Error) {
    outputFailed = true
    rejectOutput(error)
  }
  let completed = false
  let failure: string | undefined
  let eventError: string | undefined
  let childError: string | undefined
  let stderr = ''
  const lines = child?.stdout == null ? undefined : createInterface({ input: child.stdout })
  lines?.on('line', (line) => {
    if (closing || outputFailed) return
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

  function settle(code: number | null, sig: NodeJS.Signals | null) {
    if (closing) return
    closing = true
    clearTimeout(winTimer)
    lines?.close()
    void (async () => {
      await drain()
      await pidWritten
      const last = stderr.trim().split('\n').at(-1)?.trim().slice(0, 300) ?? ''
      outputDone = true
      resolveOutput({
        completed: completed && code === 0 && failure === undefined && childError === undefined,
        ...(refusal === undefined ? {} : { refusal }),
        failure:
          refusal ??
          childError ??
          failure ??
          eventError ??
          (sig !== null
            ? `${provider.label} was stopped (${sig}).`
            : `${provider.label} exited with code ${code ?? '?'}${last === '' ? '.' : `: ${last}`}`),
      })
    })().catch((error: unknown) => failOutput(rememberFailure(error)))
  }
  function requestDrain() {
    void drain().catch(() => {})
  }
  let started = child?.pid !== undefined
  child?.once('spawn', () => {
    started = true
    if (physical === undefined) {
      try {
        receipt.phase('ACTIVE')
      } catch (error) {
        rememberFailure(error)
        requestDrain()
      }
    }
  })
  child?.once('exit', () => {
    started = true
    requestDrain()
  })
  child?.once('close', settle)
  child?.on('error', (error) => {
    if (closing) return
    typed ??= windows ? undefined : posixLaunchNonAdmission(error)
    childError ??=
      started && !typed
        ? `${provider.label} process error: ${error.message}`
        : `${provider.label} did not start: ${error.message}`
    if (typed || (!started && windows)) settle(null, null)
    else requestDrain()
  })
  if (missingLease) {
    refusal = rememberFailure(
      new Error(`Job ${id} has no POSIX launch lease; its owner is unresolved.`),
    ).message
    settle(null, null)
  } else if (!child) settle(null, null)

  function signalWindows(sig: 'SIGTERM' | 'SIGKILL') {
    if (child?.pid === undefined || closing) return
    try {
      child.kill(sig)
    } catch {
      /* The owned helper may already have exited. */
    }
  }
  let stopping: Promise<void> | undefined
  return {
    refusal,
    bracket: child !== undefined && !missingLease,
    output,
    stop(finalized: Promise<void>) {
      return (stopping ??= (async () => {
        try {
          if (windows && !group && !closing) {
            signalWindows('SIGTERM')
            winTimer = setTimeout(() => signalWindows('SIGKILL'), killGraceMs)
          } else if (!outputDone) await drain()
          // The lease's physical deadline is independent of the output/provider deadline.
          await bounded(
            finalized,
            `Output and finalization of job ${id}`,
            windows && !group ? killGraceMs + 5_000 : 5_000,
          )
        } catch (error) {
          const first = rememberFailure(error)
          failOutput(first)
          throw first
        } finally {
          clearTimeout(winTimer)
        }
      })())
    },
  }
}
