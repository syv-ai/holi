import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MDX_RESOURCE_EVENTS,
  type MdxExternalResourceGrant,
  type MdxExternalResourceRequest,
} from '@holi/shared'
import { trpc } from '@/lib/trpc'

/** A lease can list and revoke grants regardless of its current compile generation. */
type Owner = Readonly<{
  id: string
  current: () => boolean
  generation: number
  compiledGeneration: number | null
  sourceVersion: number
}>

type Input = {
  identity: { remote: string | null }
  visit: object
  enabled: boolean
  currentOwner: () => Owner | null
  compileStatus: Readonly<{ checking: boolean; error: string | null }>
  requestCompile: () => void
}

type Pending = { generation: number; query: number; items: MdxExternalResourceRequest[] }
type Resources = {
  owner: Owner
  approved: MdxExternalResourceGrant[]
  pending?: Pending
  loading: boolean
  error?: string
}
type Decision = 'allow' | 'deny' | 'revoke'
type DecisionAttempt = {
  owner: Owner
  sourceVersion: number
  generation: number
  action: Decision
  origin: string
  id: string
}
type DecisionError = { attempt: DecisionAttempt; message: string }

function attemptCurrent(attempt: DecisionAttempt) {
  return (
    attempt.owner.current() &&
    (attempt.action === 'revoke' ||
      (attempt.sourceVersion === attempt.owner.sourceVersion &&
        attempt.generation === attempt.owner.generation))
  )
}

/** Lists external MDX resources and manages decisions within the current diagnostics lease. */
export function useMdxResources({
  identity,
  visit,
  enabled,
  currentOwner,
  compileStatus,
  requestCompile,
}: Input) {
  const [resources, setResources] = useState<Resources | null>(null)
  const queryOrder = useRef(0)
  const refreshPending = useRef<{ owner: Owner; generation: number } | null>(null)
  const [decisionErrors, setDecisionErrors] = useState<DecisionError[]>([])
  const [decisions, setDecisions] = useState<DecisionAttempt[]>([])
  const deciding = useRef(new Map<string, DecisionAttempt>())
  // Denial dismisses this origin in this view even if an autosave or another
  // view's event reruns diagnostics. Only an explicit run offers it here again.
  const dismissed = useRef<{ identity: object; origins: Set<string> } | null>(null)

  const readResources = useCallback(async (owner: Owner) => {
    if (!owner.current()) return
    // Grants belong to the lease, even across source edits. Only a read begun
    // after the current compile can offer approvals for that source generation.
    const generation = owner.compiledGeneration
    const query = ++queryOrder.current
    const current = () => owner.current() && queryOrder.current === query
    const approvedFor = (previous: Resources | null) =>
      previous?.owner === owner ? previous.approved : []
    setResources((previous) => ({
      owner,
      approved: approvedFor(previous),
      error: previous?.owner === owner ? previous.error : undefined,
      loading: true,
    }))
    try {
      const result = await trpc.mdxTrust.externalResources.query({ lease: owner.id })
      if (!current()) return
      const complete = result.listError === undefined
      setResources({
        owner,
        // Even an incomplete response carries the IDs main still accepts for Revoke.
        // Do not reintroduce an ID main already retired after a saved removal.
        approved: result.approved,
        pending:
          complete &&
          generation !== null &&
          generation === owner.generation &&
          generation === result.generation
            ? { generation, query, items: result.pending }
            : undefined,
        loading: false,
        error: result.listError,
      })
      // Only a complete list confirms removals saved in another split.
      if (!complete) return
      const approvedIds = new Set(result.approved.map(({ id }) => id))
      setDecisionErrors((previous) =>
        previous.filter(
          ({ attempt }) =>
            attempt.owner !== owner || attempt.action !== 'revoke' || approvedIds.has(attempt.id),
        ),
      )
    } catch (error) {
      if (current())
        setResources((previous) => ({
          owner,
          approved: approvedFor(previous),
          loading: false,
          error: errorMessage(error),
        }))
    }
  }, [])

  const flushDiagnosticsRefresh = useCallback(
    (owner: Owner) => {
      // Only resource-triggered refreshes wait for live local decisions. A new
      // source or compile generation supersedes any deferred refresh.
      if (
        !owner.current() ||
        refreshPending.current?.owner !== owner ||
        refreshPending.current.generation !== owner.generation ||
        [...deciding.current.values()].some(attemptCurrent)
      )
        return
      refreshPending.current = null
      requestCompile()
    },
    [requestCompile],
  )

  const owner = currentOwner()
  const compiledGeneration = owner?.compiledGeneration
  useEffect(() => {
    if (!owner) {
      setResources(null)
      setDecisionErrors([])
      setDecisions([])
      deciding.current.clear()
      refreshPending.current = null
      return
    }
    // Load grants on lease acquisition, then read offers after each completed
    // compile. Starting another generation by itself only retires old offers.
    if (owner.compiledGeneration === compiledGeneration) void readResources(owner)
  }, [owner, compiledGeneration, readResources])

  const remote = identity.remote
  useEffect(() => {
    if (!enabled || !remote) return
    return window.holi?.plugin?.on(MDX_RESOURCE_EVENTS, (event) => {
      if (event.name !== 'changed' || event.remote !== remote.toLowerCase()) return
      const owner = currentOwner()
      if (!owner) return
      refreshPending.current = { owner, generation: owner.generation }
      flushDiagnosticsRefresh(owner)
      void readResources(owner)
    })
  }, [enabled, remote, currentOwner, flushDiagnosticsRefresh, readResources])

  const explicitRun = useCallback(() => {
    dismissed.current = null
    const owner = currentOwner()
    if (owner) void readResources(owner)
  }, [currentOwner, readResources])

  const currentResources = owner?.current() && resources?.owner === owner ? resources : null
  const approved = currentResources?.approved ?? []
  const pendingSnapshot = currentResources?.pending
  const pendingCurrent = () =>
    owner?.current() &&
    pendingSnapshot?.generation === owner.generation &&
    pendingSnapshot.query === queryOrder.current
  const pending = pendingCurrent()
    ? (pendingSnapshot?.items ?? []).filter(
        ({ origin }) =>
          dismissed.current?.identity !== identity || !dismissed.current.origins.has(origin),
      )
    : []
  const updatingOrigins = decisions.filter(attemptCurrent).map(({ origin }) => origin)
  const queryError =
    currentResources?.error && owner
      ? {
          message: currentResources.error,
          retrying: currentResources.loading,
          retry: () => void readResources(owner),
        }
      : null
  // A diagnostic rerun can replace offers; a failure still belongs to the
  // origin and source that the user reviewed (or to the lease for revocation).
  const errors = decisionErrors.filter(({ attempt }) => decisionErrorCurrent(attempt))

  function decisionErrorCurrent(attempt: DecisionAttempt) {
    return (
      attempt.owner.current() &&
      (attempt.action === 'revoke' || attempt.sourceVersion === attempt.owner.sourceVersion)
    )
  }

  function originUpdating(origin: string) {
    const attempt = deciding.current.get(origin)
    return attempt !== undefined && attemptCurrent(attempt)
  }

  function retryDecision(attempt: DecisionAttempt) {
    if (!decisionErrorCurrent(attempt) || originUpdating(attempt.origin)) return
    if (attempt.action === 'revoke') {
      if (approved.some(({ id }) => id === attempt.id)) void decide('revoke', attempt.id)
      else void readResources(attempt.owner)
      return
    }
    setDecisionErrors((previous) => previous.filter((error) => error.attempt !== attempt))
    // Obtain a fresh request, never automatically approve a replacement.
    refreshPending.current = { owner: attempt.owner, generation: attempt.owner.generation }
    flushDiagnosticsRefresh(attempt.owner)
    void readResources(attempt.owner)
  }

  async function decide(action: Decision, id: string) {
    if (!owner?.current() || (action !== 'revoke' && !pendingCurrent())) return
    const item = (action === 'revoke' ? approved : pending).find((item) => item.id === id)
    if (!item || originUpdating(item.origin)) return
    const { origin } = item
    const attempt = {
      owner,
      sourceVersion: owner.sourceVersion,
      generation: owner.generation,
      action,
      origin,
      id,
    }
    deciding.current.set(origin, attempt)
    setDecisions((previous) => [...previous.filter((item) => item.origin !== origin), attempt])
    setDecisionErrors((previous) => previous.filter((error) => error.attempt.origin !== origin))
    try {
      if (action === 'deny') {
        await trpc.mdxTrust.rejectExternalResource.mutate({ lease: owner.id, requestId: id })
        if (!attemptCurrent(attempt)) return
        if (dismissed.current?.identity !== identity)
          dismissed.current = { identity, origins: new Set() }
        dismissed.current.origins.add(origin)
      } else {
        if (action === 'allow')
          await trpc.mdxTrust.approveExternalResource.mutate({ lease: owner.id, requestId: id })
        else await trpc.mdxTrust.revokeExternalResource.mutate({ lease: owner.id, grantId: id })
        if (attemptCurrent(attempt))
          refreshPending.current = { owner, generation: owner.generation }
      }
    } catch (error) {
      if (attemptCurrent(attempt))
        setDecisionErrors((previous) => [...previous, { attempt, message: errorMessage(error) }])
    } finally {
      if (deciding.current.get(origin) === attempt) deciding.current.delete(origin)
      setDecisions((previous) => previous.filter((item) => item !== attempt))
      if (attemptCurrent(attempt)) {
        flushDiagnosticsRefresh(owner)
        // For revoke, the push can arrive before persistence has settled.
        void readResources(owner)
      }
    }
  }

  return {
    explicitRun,
    model: enabled
      ? {
          approved,
          pending,
          loading: compileStatus.checking || currentResources?.loading === true,
          queryError,
          decisionErrors: errors.map(({ attempt, message }) => ({
            origin: attempt.origin,
            message: `${attempt.origin}: ${message}`,
            retry: () => retryDecision(attempt),
          })),
          diagnosticsError: compileStatus.error,
          updatingOrigins,
          visit,
          decide,
        }
      : null,
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
