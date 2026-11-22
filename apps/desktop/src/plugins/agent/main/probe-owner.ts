import { UnconfirmedOwnedProgramError } from '../../../main/plugin-api'

export type AgentProbeOwner = ReturnType<typeof createAgentProbeOwner>

/** Settings Test and version share one owner per agent activation. The probes
 * already bound their own stop and join; this owner joins those same promises,
 * then revokes each failed launch's original cleanup lease once. */
export function createAgentProbeOwner(activationSignal: AbortSignal) {
  const pending = new Set<Promise<unknown>>()
  const failures = new Set<UnconfirmedOwnedProgramError>()
  let stopping: Promise<void> | undefined

  return {
    run<T>(probe: () => Promise<T>): Promise<T> {
      for (const failure of failures) return Promise.reject(failure)
      if (stopping || activationSignal.aborted)
        return Promise.reject(new Error('Agent probe activation was cancelled'))

      const work = probe()
      pending.add(work)
      // Observe before any caller can discard a stale result. Even if the
      // activation has since been revoked, this launch still belongs here.
      void work.then(
        () => pending.delete(work),
        (error: unknown) => {
          if (error instanceof UnconfirmedOwnedProgramError) failures.add(error)
          pending.delete(work)
        },
      )
      return work
    },

    stop(): Promise<void> {
      return (stopping ??= (async () => {
        await Promise.allSettled(pending)
        const leases = new Set([...failures].flatMap((error) => (error.lease ? [error.lease] : [])))
        const revoked = await Promise.allSettled([...leases].map(async (lease) => lease.revoke()))
        const errors = new Set<unknown>(failures)
        for (const result of revoked) if (result.status === 'rejected') errors.add(result.reason)
        // Even a successful revoke cannot erase the original proof failure.
        if (errors.size === 1) throw errors.values().next().value
        if (errors.size > 1) throw new AggregateError(errors, 'agent probes failed to drain')
      })())
    },
  }
}
