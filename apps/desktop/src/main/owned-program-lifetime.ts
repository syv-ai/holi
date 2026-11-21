import { ChildProcess } from 'node:child_process'

/** `empty` is authenticated native Job zero; `not-started` proves no helper was created. */
export type OwnedCompletion = 'empty' | 'not-started'

export interface ManagedOwnedChild extends ChildProcess {
  /** Always present on Windows; omitted on POSIX. Never inferred from a missing pid. */
  readonly ownedCompletion?: Promise<OwnedCompletion>
}

/** Cleanup authority for this exact launch, not for a pid or a later replacement.
 * @public plugin seam */
export interface OwnedProgramCleanupLease {
  /** Idempotent: resolve only after physical drain; retain the failure if drain cannot be proved. */
  revoke(): Promise<void>
}

/** Private retained-launch seam. The backend need not expose its native conduit. */
interface RetainedOwnedProgramLease extends OwnedProgramCleanupLease {
  /** First call owns admission. If aborted before the release grant, reject with
   * signal.reason after joining the preparing broker; the caller still joins revoke.
   * After the grant, only the native decision determines commit. */
  commit(signal?: AbortSignal): Promise<void>
}

/** Private fourth execProgram callback argument. The first argument stays the original
 * command/output error (not replaced by stderr or a later timeout); cleanup failure
 * goes in this metadata. A settled handoff carries its still-revocable lease. */
export type RetainedExecMetadata =
  | { readonly kind: 'settled'; readonly lease?: RetainedOwnedProgramLease }
  | {
      readonly kind: 'unconfirmed'
      /** If present, the Job was proved empty; only resource cleanup is unconfirmed. */
      readonly ownership?: 'empty'
      readonly cause: unknown
      readonly lease: OwnedProgramCleanupLease
    }

/** A retained EMPTY joined, but its parent's Job handle cleanup did not. */
export class OwnedProgramResourceCleanupError extends Error {
  declare readonly cause: unknown

  constructor(
    cause: unknown,
    readonly lease: OwnedProgramCleanupLease,
  ) {
    super('Could not confirm Windows owned-program resource cleanup after Job zero', { cause })
    this.name = 'OwnedProgramResourceCleanupError'
  }
}

/** @public plugin seam */
export class UnconfirmedOwnedProgramError extends Error {
  declare readonly cause: unknown

  constructor(
    cause: unknown,
    /** Undefined for malformed/legacy adapters that supplied no cleanup authority. */
    readonly lease?: OwnedProgramCleanupLease,
    readonly commandError: Error | null = null,
  ) {
    super('Could not confirm Windows owned-program completion', { cause })
    this.name = 'UnconfirmedOwnedProgramError'
  }
}

/** @public plugin seam */
export interface OwnedProgramResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  /** First child/stdio/collection error. Nonzero status is reported separately. */
  readonly error: Error | null
  /** Undefined on POSIX, where callers still own process-group teardown. */
  readonly ownership: OwnedCompletion | undefined
}

const joins = new WeakMap<ManagedOwnedChild, Promise<OwnedProgramResult>>()
const outputGraceMs = 5000
const ignoreLateError = () => undefined

/** Call synchronously after launch, before events. Callers keep reading output and
 * requesting stop as before, through child.kill on Windows. Rejoins share the first
 * observation (including platform), not another race against the receipt.
 * @public plugin seam */
export function joinOwnedProgram(
  child: ManagedOwnedChild,
  platform: NodeJS.Platform,
): Promise<OwnedProgramResult> {
  const existing = joins.get(child)
  if (existing) return existing

  let resolve!: (result: OwnedProgramResult) => void
  let reject!: (reason: UnconfirmedOwnedProgramError) => void
  const promise = new Promise<OwnedProgramResult>((res, rej) => {
    resolve = res
    reject = rej
  })
  joins.set(child, promise)
  // Owners may wait until stop to await this promise, but observation starts now.
  void promise.catch(ignoreLateError)

  if (platform === 'win32') observeWindowsOwnedProgram(child, resolve, reject)
  else {
    let error: Error | null = null
    const detach = observeErrors(child, (failure) => (error ??= failure))
    child.once('close', (code, signal) => {
      detach()
      resolve({ code, signal, error, ownership: undefined })
    })
  }
  return promise
}

type OwnedStatus = Pick<OwnedProgramResult, 'code' | 'signal'>
// HANDOFF belongs to the private exec adapter, never to ManagedOwnedChild.
type WindowsExecChild = ChildProcess & {
  readonly ownedCompletion?: Promise<OwnedCompletion | 'handoff'>
}

interface WindowsExecPolicy {
  statusError(status: OwnedStatus): Error | null
  requestStop(): void
  lease?: OwnedProgramCleanupLease
  handoff?: {
    onOutputEnd(): void
    acknowledged(): boolean
    complete(error: Error | null): void
  }
}

/** The shared Windows join. Exec supplies error/stop policy and, only in retained
 * mode, the ACK and handoff policy. None of those policies can substitute for
 * status, output settlement, or the receipt. */
export function observeWindowsOwnedProgram(
  child: WindowsExecChild,
  complete: (result: OwnedProgramResult) => void,
  reject: (reason: UnconfirmedOwnedProgramError) => void,
  exec?: WindowsExecPolicy,
) {
  let ownership: OwnedCompletion | 'handoff' | undefined
  let status: OwnedStatus | undefined
  let closed = false
  let error: Error | null = null
  let finished = false
  let deadline: NodeJS.Timeout | undefined
  const outputs = (
    [
      ['stdout', child.stdout],
      ['stderr', child.stderr],
    ] as const
  ).map(([name, stream]) => ({
    name,
    stream,
    ended: !stream,
    settled: !stream,
    awaitingClose: false,
  }))
  const detach: (() => void)[] = []
  const record = (failure: Error) => {
    if (!finished) error ??= failure
  }
  const canAcknowledge = () => !finished && !error && outputs.every(({ ended }) => ended)
  const finish = () => {
    finished = true
    clearTimeout(deadline)
    for (const remove of detach) remove()
  }
  const advance = () => {
    if (finished || !status || !ownership || outputs.some(({ settled }) => !settled)) return
    if (ownership === 'not-started' && !closed) return
    finish()
    if (ownership === 'handoff') {
      exec!.handoff!.complete(error)
      return
    }
    const commandStatus = ownership === 'not-started' ? { code: null, signal: null } : status
    complete({ ...commandStatus, error, ownership })
  }
  const unconfirmed = (cause: unknown, invalid = false) => {
    if (finished) return
    const original = cause instanceof UnconfirmedOwnedProgramError ? cause : undefined
    const commandError = error ?? original?.commandError ?? null
    const lease = original ? original.lease : exec?.lease
    const failure =
      original && original.commandError === commandError && original.lease === lease
        ? original
        : new UnconfirmedOwnedProgramError(original ? original.cause : cause, lease, commandError)
    finish()
    if (invalid) exec?.requestStop()
    reject(failure)
  }
  const boundOutput = () => {
    if (finished || deadline || outputs.every(({ settled }) => settled)) return
    deadline = setTimeout(() => {
      for (const output of outputs) {
        if (output.settled) continue
        record(new Error(`Owned program ${output.name} did not settle within ${outputGraceMs} ms`))
        // destroy() requests teardown; only the stream can report its completion.
        output.awaitingClose = true
        output.stream?.destroy()
      }
    }, outputGraceMs).unref()
  }

  const kill = child.kill
  const ownKill: ChildProcess['kill'] = function (this: ChildProcess, signal) {
    // The owned adapter's kill is a stop request, not Node's signal-zero probe.
    if (signal === 0) return ChildProcess.prototype.kill.call(this, 0)
    const result = kill.call(this, signal)
    boundOutput()
    return result
  }
  child.kill = ownKill
  detach.push(() => {
    if (child.kill === ownKill) child.kill = kill
  })

  // Handle child errors before looking at the adapter's receipt (including getters).
  detach.push(
    observeErrors(child, (failure, fromChild) => {
      record(failure)
      if (!fromChild) exec?.requestStop()
    }),
  )
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (!status) {
      status = { code, signal }
      const failure = exec?.statusError(status)
      if (failure) record(failure)
    }
    boundOutput()
    advance()
  }
  const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
    closed = true
    onExit(code, signal)
  }
  child.once('exit', onExit)
  child.once('close', onClose)
  detach.push(
    () => child.off('exit', onExit),
    () => child.off('close', onClose),
  )
  if (child.exitCode != null || child.signalCode != null)
    onExit(child.exitCode ?? null, child.signalCode ?? null)

  for (const output of outputs) {
    const { name, stream } = output
    if (!stream) continue
    const end = () => {
      output.ended = true
      if (!output.awaitingClose) output.settled = true
      if (canAcknowledge()) exec?.handoff?.onOutputEnd()
      advance()
    }
    const close = () => {
      if (!output.settled && !stream.readableEnded) {
        record(new Error(`Owned program ${name} closed before end`))
        if (ownership === undefined) exec?.requestStop()
      }
      output.settled = true
      if (stream.readableEnded && !output.ended) {
        output.ended = true
        if (canAcknowledge()) exec?.handoff?.onOutputEnd()
      }
      advance()
    }
    stream.once('end', end)
    stream.once('close', close)
    detach.push(
      () => stream.off('end', end),
      () => stream.off('close', close),
    )
    if (stream.closed) close()
    else if (stream.readableEnded) end()
  }

  try {
    const receipt: unknown = child.ownedCompletion
    if (receipt == null)
      throw new TypeError('Windows owned program has no authenticated ownership completion')
    // Even a valid completion literal is not proof without a receipt container.
    if (typeof receipt !== 'object' && typeof receipt !== 'function')
      throw new TypeError('Invalid Windows ownership receipt container')
    void Promise.resolve<unknown>(receipt).then((value) => {
      if (
        value !== 'empty' &&
        value !== 'not-started' &&
        !(value === 'handoff' && exec?.handoff?.acknowledged())
      ) {
        unconfirmed(
          new TypeError('Invalid receipt for Windows owned program', { cause: value }),
          true,
        )
        return
      }
      ownership = value
      boundOutput()
      advance()
    }, unconfirmed)
  } catch (cause) {
    // Covers receipt property access and synchronous failures subscribing to a
    // Promise. Promise.resolve itself assimilates foreign thenables safely.
    queueMicrotask(() => unconfirmed(cause, true))
  }
  return { record, canAcknowledge }
}

function observeErrors(child: ChildProcess, onError: (error: Error, fromChild: boolean) => void) {
  const detach: (() => void)[] = []
  for (const source of new Set([child, child.stdin, child.stdout, child.stderr])) {
    if (!source) continue
    const record = (error: Error) => onError(error, source === child)
    source.on('error', record)
    detach.push(() => {
      source.off('error', record)
      // Proof failure may precede native teardown. Keep late errors handled
      // without retaining the join or changing its reported first error.
      source.on('error', ignoreLateError)
    })
    if ('errored' in source && source.errored) record(source.errored)
  }
  return () => {
    for (const remove of detach) remove()
  }
}
