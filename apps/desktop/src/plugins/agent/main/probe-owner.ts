import {
  UnconfirmedOwnedProgramError,
  type ProcessGroupSupervision,
} from '../../../main/plugin-api'

/** A failed proof belongs to its original probe even after later cleanup. */
export class AgentProbeCleanupError extends Error {
  constructor(
    cause: unknown,
    readonly authority?: ProcessGroupSupervision,
  ) {
    super('Could not confirm agent probe cleanup', { cause })
    this.name = 'AgentProbeCleanupError'
  }
}

export type AgentProbeOwner = ReturnType<typeof createAgentProbeOwner>

/** One activation owns admission, cancellation and the original cleanup failures. */
export function createAgentProbeOwner(activationSignal: AbortSignal) {
  const pending = new Set<Promise<unknown>>()
  const controllers = new Set<AbortController>()
  const failures = new Set<UnconfirmedOwnedProgramError | AgentProbeCleanupError>()
  let stopping: Promise<void> | undefined
  const cancel = () => {
    for (const controller of controllers) controller.abort()
  }
  activationSignal.addEventListener('abort', cancel, { once: true })

  return {
    run<T>(probe: (signal: AbortSignal) => Promise<T>): Promise<T> {
      for (const failure of failures) return Promise.reject(failure)
      if (stopping || activationSignal.aborted)
        return Promise.reject(new Error('Agent probe activation was cancelled'))

      const controller = new AbortController()
      controllers.add(controller)
      let resolveWork!: (value: T | PromiseLike<T>) => void
      let rejectWork!: (reason: unknown) => void
      const work = new Promise<T>((resolve, reject) => {
        resolveWork = resolve
        rejectWork = reject
      })
      pending.add(work)
      // Observe and register before setup can throw or re-enter stop.
      void work.then(
        () => {
          pending.delete(work)
          controllers.delete(controller)
        },
        (error: unknown) => {
          if (
            error instanceof UnconfirmedOwnedProgramError ||
            error instanceof AgentProbeCleanupError
          )
            failures.add(error)
          pending.delete(work)
          controllers.delete(controller)
        },
      )
      try {
        resolveWork(probe(controller.signal))
      } catch (error) {
        rejectWork(error)
      }
      return work
    },

    stop(): Promise<void> {
      if (stopping) return stopping
      let resolveStop!: () => void
      let rejectStop!: (reason: unknown) => void
      // Close admission before abort handlers can re-enter either method.
      stopping = new Promise<void>((resolve, reject) => {
        resolveStop = resolve
        rejectStop = reject
      })
      cancel()
      activationSignal.removeEventListener('abort', cancel)
      void (async () => {
        await Promise.allSettled(pending)
        const leases = new Set(
          [...failures].flatMap((error) =>
            error instanceof UnconfirmedOwnedProgramError && error.lease ? [error.lease] : [],
          ),
        )
        const authorities = new Set(
          [...failures].flatMap((error) =>
            error instanceof AgentProbeCleanupError && error.authority ? [error.authority] : [],
          ),
        )
        const revoked = await Promise.allSettled([
          ...[...leases].map(async (lease) => lease.revoke()),
          ...[...authorities].map(async (authority) => authority.drain()),
        ])
        const lateLeases = new Set<NonNullable<UnconfirmedOwnedProgramError['lease']>>()
        const errors = new Set<unknown>(failures)
        for (const result of revoked) {
          if (result.status !== 'rejected') continue
          errors.add(result.reason)
          if (result.reason instanceof UnconfirmedOwnedProgramError && result.reason.lease)
            lateLeases.add(result.reason.lease)
        }
        for (const lease of lateLeases) {
          const result = await Promise.allSettled([lease.revoke()])
          if (result[0]?.status === 'rejected') errors.add(result[0].reason)
        }
        if (errors.size === 1) throw errors.values().next().value
        if (errors.size > 1) throw new AggregateError(errors, 'agent probes failed to drain')
      })().then(resolveStop, rejectStop)
      return stopping
    },
  }
}
