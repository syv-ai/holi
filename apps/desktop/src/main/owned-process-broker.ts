import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { addAbortListener } from 'node:events'
import {
  createOwnedProtocol,
  type JobAction,
  type OwnedProcessMessage,
} from './owned-process-protocol'
import { win32Adapter } from './owned-process-win32'
import type { RetainedExecMetadata } from './owned-program-lifetime'

type RetainedOwnedProgramLease = NonNullable<
  Extract<RetainedExecMetadata, { kind: 'settled' }>['lease']
>

interface PreparedJob {
  readonly launchId: string
  readonly secret: Buffer
  readonly parentPid: number
  readonly jobId: string
  readonly commitGuardId: string
}

type BoundJob = PreparedJob & { readonly parentBirth: string }
type AdoptedJob = BoundJob & { readonly jobHandle: string; readonly commitGuardHandle: string }
type Registration = Pick<
  AdoptedJob,
  'jobId' | 'commitGuardId' | 'parentBirth' | 'jobHandle' | 'commitGuardHandle'
>

/** The parent owns both source slots from their creation. Revoke freezes admission
 * synchronously, then joins the producer before spending that one cleanup authority. */
export function ownedJobLease({
  prepared,
  joinProducer,
  broker = runBroker,
}: {
  prepared?: PreparedJob
  joinProducer: () => Promise<void>
  broker?: typeof runBroker
}) {
  let bound: BoundJob | undefined
  let adopted: AdoptedJob | undefined
  let commit: Promise<void> | undefined
  let revoke: Promise<void> | undefined
  let grantMayBeSent = false
  let committed = false
  let stopped = false
  let handedOff = false
  let empty = false
  const lease: RetainedOwnedProgramLease = {
    commit: (signal) => {
      return (commit ??= Promise.resolve().then(async () => {
        signal?.throwIfAborted()
        if (!handedOff || !adopted || stopped || revoke)
          throw new Error('owned handoff is not available to commit')
        try {
          await broker(
            adopted,
            'release',
            () => {
              // Admission is checked again after native preparation, in the
              // same stack as the grant write. Treat even a failed write as sent.
              signal?.throwIfAborted()
              if (stopped || revoke) return false
              grantMayBeSent = true
              return true
            },
            () => {
              committed = true
            },
            undefined,
            signal,
          )
          if (!committed) throw new Error('owned Job broker did not prove native commit')
        } catch (error) {
          if (!committed) {
            // Without a proved decision we never authorized closeSources. Join
            // the broker and preserve the first cause even if rollback fails.
            if (grantMayBeSent) void lease.revoke().catch(() => undefined)
            throw error
          }
          // The commit decision was proved. Housekeeping may have consumed either
          // slot; leave any remaining inert handles to parent exit.
        } finally {
          grantMayBeSent = false
        }
      }))
    },
    revoke: () => {
      if (revoke) return revoke
      stopped = true
      const ticket = adopted ?? bound // freeze pending versus adopted before yielding
      const action = adopted ? 'revoke' : 'recover'
      revoke = Promise.resolve().then(async () => {
        // Release must physically join before either of its source slots is reused.
        if (commit) await commit.catch(() => undefined)
        if (committed) throw new Error('owned handoff was already committed')
        if (!empty) await joinProducer()
        if (ticket) await broker(ticket, action, () => true)
        else if (!empty && !prepared) throw new Error('no registered native Job cleanup handle')
        // Retained but never bound for AUTH: no duplicate or Root was possible.
      })
      // Cleanup may start before an owner joins it. Keep the original rejection
      // on this promise for every observer; never retry an uncertain source close.
      void revoke.catch(() => undefined)
      return revoke
    },
  }
  return {
    lease,
    get cleanup() {
      return revoke
    },
    bindForAuth(parentBirth: string) {
      if (!prepared || bound || revoke) throw new Error('cannot bind native Job for AUTH')
      bound = { ...prepared, parentBirth }
    },
    get authMayHaveBeenSent() {
      return bound !== undefined
    },
    adopt(value: Registration) {
      if (!bound || adopted || revoke) throw new Error('cannot adopt native Job registration')
      if (
        value.jobId !== bound.jobId ||
        value.commitGuardId !== bound.commitGuardId ||
        value.parentBirth !== bound.parentBirth
      )
        throw new Error('owned Job registration does not match prepared identity')
      adopted = { ...bound, jobHandle: value.jobHandle, commitGuardHandle: value.commitGuardHandle }
    },
    markStop() {
      if (grantMayBeSent || committed) return false
      stopped = true
      return true
    },
    handedOff() {
      handedOff = true
    },
    releaseEmpty() {
      // The producer already joined with verified zero. Reuse the same cleanup
      // operation to close retained slots, without changing the EMPTY receipt.
      empty = true
      return lease.revoke()
    },
  }
}

type CleanupReceipt = Extract<OwnedProcessMessage, { type: 'recovered' }> | { type: 'drained' }

/** The optional instrumentation is private to the native fixture. @public */
export function runBroker(
  ticket: BoundJob | AdoptedJob,
  action: JobAction,
  grant: () => boolean,
  committed?: () => void,
  fixture?: {
    transformSource: (source: string) => string
    directory: string
    closed(observation: {
      code: number | null
      signal: NodeJS.Signals | null
      eof: boolean
      receipt: CleanupReceipt | null
    }): void
  },
  admission?: AbortSignal,
): Promise<void> {
  const { jobId, commitGuardId } = ticket
  const binding = { jobId, commitGuardId }
  const launchId = `${ticket.launchId}:${jobId}:${commitGuardId}:${randomUUID()}`
  const protocol = createOwnedProtocol({ launchId, secret: ticket.secret, role: 'parent' })
  const adapter = win32Adapter('RunBroker', process.env, fixture?.transformSource)
  return new Promise((resolve, reject) => {
    const child = spawn(adapter.file, adapter.args, {
      cwd: adapter.cwd,
      env: adapter.env,
      // Don't let libuv's parent-owned kill-on-close Job kill our rollback
      // broker during a guard-clear/OBSERVED race. Keep the child and pipes referenced.
      detached: true,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    let stage: 'preparing' | 'granted' | 'observing' | 'closing' | 'proved' = 'preparing'
    let closed = false
    let receipt: CleanupReceipt | null = null
    let failure: { cause: unknown } | undefined
    let timer = setTimeout(
      () => fail(new Error('owned Job broker setup timed out')),
      15_000,
    ).unref()
    function fail(cause: unknown) {
      if (closed || failure) return
      failure = { cause }
      clearTimeout(timer)
      child.stdin.destroy()
      child.stdout.destroy()
      // Once a grant may have reached native code, EOF is the abort signal.
      // Don't kill the process that might own the only rollback handles.
      if (stage === 'preparing') {
        try {
          child.kill('SIGKILL')
        } catch {
          /* EOF still aborts preparation */
        }
      }
    }
    child.on('error', fail)
    child.stdin.on('error', fail)
    child.stdout.on('error', fail)
    child.stdout.on('end', () => {
      if (stage !== 'proved') fail(new Error('owned Job broker ended without proof'))
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return
      try {
        for (const message of protocol.push(chunk)) {
          if (message.type === 'error') throw new Error(`owned Job broker reported ${message.code}`)
          if (
            stage === 'observing' &&
            message.type === 'phase' &&
            message.phase === 'commit-observed' &&
            message.rootPid === null &&
            message.state === 'clear'
          ) {
            // OBSERVED was accepted. Only now can the parent give up its
            // original slots. A failure around close can't make them reusable.
            committed?.()
            stage = 'closing'
            child.stdin.end(protocol.encode({ type: 'closeSources', ...binding }))
            continue
          }
          if (
            !('jobId' in message) ||
            message.jobId !== jobId ||
            message.commitGuardId !== commitGuardId
          )
            throw new Error('owned Job broker identity mismatch')
          if (stage === 'preparing' && message.type === 'brokerReady') {
            const frame = protocol.encode({ type: 'grant', action, ...binding })
            if (!grant()) throw new Error('owned Job release lost to stop')
            stage = 'granted'
            abortListener?.[Symbol.dispose]()
            if (action !== 'release') child.stdin.end(frame)
            else child.stdin.write(frame)
            clearTimeout(timer)
            timer = setTimeout(
              () => fail(new Error('owned Job broker cleanup timed out')),
              5000,
            ).unref()
          } else if (stage === 'granted' && action === 'release' && message.type === 'committed') {
            // Do not forget the lease on a successful pipe write. Only the
            // native decision can distinguish accepted OBSERVED from rollback.
            stage = 'observing'
            child.stdin.write(protocol.encode({ type: 'acknowledge' }))
          } else if (
            (stage === 'granted' && action === 'revoke' && message.type === 'drained') ||
            (stage === 'granted' &&
              action === 'recover' &&
              message.type === 'recovered' &&
              message.parentPid === ticket.parentPid &&
              message.parentBirth === ticket.parentBirth) ||
            (stage === 'closing' && message.type === 'released')
          ) {
            if (fixture) {
              if (message.type === 'recovered') receipt = message
              if (message.type === 'drained') receipt = { type: message.type }
            }
            stage = 'proved'
          } else throw new Error('unexpected owned Job broker record')
        }
      } catch (error) {
        fail(error)
      }
    })
    // A terminal frame and EOF prove the transcript, not that the referenced
    // broker and its stdio have closed. Both outcomes join this same child.
    child.once('close', (code, signal) => {
      closed = true
      clearTimeout(timer)
      abortListener?.[Symbol.dispose]()
      fixture?.closed({ code, signal, eof: child.stdout.readableEnded, receipt })
      if (failure) {
        reject(failure.cause)
        return
      }
      try {
        protocol.finish()
        if (stage !== 'proved' || code !== 0 || signal !== null || !child.stdout.readableEnded)
          throw new Error('owned Job broker exited without proof')
        resolve()
      } catch (error) {
        reject(error)
      }
    })
    const abort = () => {
      if (stage === 'preparing') fail(admission!.reason)
    }
    const abortListener = admission && addAbortListener(admission, abort)
    if (admission?.aborted) {
      abort()
      return
    }
    child.stdin.write(
      JSON.stringify({
        ...ticket,
        ...(fixture ? { fixtureDirectory: fixture.directory } : {}),
        action,
        launchId,
        secret: ticket.secret.toString('base64'),
      }) + '\n',
    )
  })
}
