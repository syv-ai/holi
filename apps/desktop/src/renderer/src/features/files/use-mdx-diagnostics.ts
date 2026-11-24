import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  MDX_RESOURCE_EVENTS,
  type MdxCompileState,
  type MdxDiagnostic,
  type MdxExternalResourceGrant,
  type MdxExternalResourceRequest,
} from '@holi/shared'
import { useAtomValue, useStore } from 'jotai'
import { setDiagnostics } from '@codemirror/lint'
import type { EditorView } from '@codemirror/view'
import { trpc } from '@/lib/trpc'
import { sessionAtom } from '@/state/session'
import { activeRemoteAtom, activeRemoteRevisionValueAtom, openedRemoteAtom } from '@/state/vaults'

const DEBOUNCE_MS = 300

type Input = {
  view: EditorView | null
  remote: string | null
  path: string
  context: string | null
  trusted: boolean
  visible: boolean
  sourceRevision: number
}

type Scope = Input & { identityCurrent: () => boolean; vaultOpen: boolean }
type Lease = {
  id: string
  current: () => boolean
  generation: number
  compiled: number | null
  query: number
  refreshPending: boolean
}
type Pending = { generation: number; query: number; items: MdxExternalResourceRequest[] }
type Resources = {
  owner: Lease
  approved: MdxExternalResourceGrant[]
  pending?: Pending
  loading: boolean
  error?: string
}
type Decision = 'allow' | 'deny' | 'revoke'
type DecisionAttempt = {
  owner: Lease
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
    (attempt.action === 'revoke' || attempt.generation === attempt.owner.generation)
  )
}

/** Owns diagnostics and external resource decisions for one visible source editor. */
export function useMdxDiagnostics(input: Input) {
  const { view, remote, path, context, trusted, visible, sourceRevision } = input
  const viewer = useAtomValue(sessionAtom)
  const openedRemote = useAtomValue(openedRemoteAtom)
  const revision = useAtomValue(activeRemoteRevisionValueAtom)
  const store = useStore()
  const identity = useMemo(
    () => ({ view, remote, path, viewer, openedRemote, revision }),
    [view, remote, path, viewer, openedRemote, revision],
  )
  const scope = useMemo<Scope>(
    () => ({
      view: identity.view,
      remote: identity.remote,
      path: identity.path,
      context,
      trusted,
      visible,
      sourceRevision,
      vaultOpen: identity.viewer != null && identity.openedRemote === identity.remote,
      identityCurrent: () =>
        store.get(sessionAtom) === identity.viewer &&
        store.get(openedRemoteAtom) === identity.openedRemote &&
        store.get(activeRemoteAtom) === identity.remote &&
        store.get(activeRemoteRevisionValueAtom) === identity.revision,
    }),
    [identity, context, trusted, visible, sourceRevision, store],
  )
  const renderedScope = useRef(scope)
  renderedScope.current = scope
  const ownerScope = useRef<Scope | null>(null)
  const [state, setState] = useState<MdxCompileState>({
    kind: 'unavailable',
    message: 'Approve this vault to check MDX syntax.',
  })
  const [retryRevision, setRetryRevision] = useState(0)
  const [ownershipRevision, setOwnershipRevision] = useState(0)
  const lease = useRef<Lease | null>(null)
  const lifetime = useRef(0)
  const timer = useRef<number | undefined>(undefined)
  const latestSource = useRef<string | null>(null)
  const active = useRef(true)
  const refreshAttempt = useRef('')
  const [resources, setResources] = useState<Resources | null>(null)
  const sourceVersion = useRef(0)
  const [renderedSourceVersion, setRenderedSourceVersion] = useState(0)
  const visit = useMemo(
    () => ({ scope, ownershipRevision, renderedSourceVersion }),
    [scope, ownershipRevision, renderedSourceVersion],
  )
  const [decisionErrors, setDecisionErrors] = useState<DecisionError[]>([])
  const [decisions, setDecisions] = useState<DecisionAttempt[]>([])
  const deciding = useRef(new Map<string, DecisionAttempt>())
  // Denial dismisses this origin in this view even if an autosave or another
  // view's event reruns diagnostics. Only an explicit run offers it here again.
  const dismissed = useRef<{ identity: object; origins: Set<string> } | null>(null)
  const clear = useCallback((target: EditorView | null, owner: Scope | null) => {
    if (
      target &&
      owner &&
      owner.view === target &&
      /^.+\.mdx$/i.test(owner.path) &&
      ownerScope.current === owner &&
      target.dom.isConnected
    )
      target.dispatch(setDiagnostics(target.state, []))
  }, [])

  const readResources = useCallback(async (owner: Lease) => {
    if (!owner.current()) return
    // Grants belong to the lease, even across source edits. Only a read begun
    // after the current compile can offer approvals for that source generation.
    const generation = owner.compiled
    const query = ++owner.query
    const current = () => owner.current() && owner.query === query
    const approvedFor = (previous: Resources | null) =>
      previous?.owner === owner ? previous.approved : []
    setResources((previous) => ({ owner, approved: approvedFor(previous), loading: true }))
    try {
      const result = await trpc.mdxTrust.externalResources.query({ lease: owner.id })
      if (!current()) return
      setResources({
        owner,
        approved: result.approved,
        pending:
          generation !== null && generation === owner.generation && generation === result.generation
            ? { generation, query, items: result.pending }
            : undefined,
        loading: false,
      })
      // A blocked grant keeps its ID until removal is saved. A current successful
      // list also confirms removals saved in another split.
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

  const schedule = useCallback(
    (
      target: EditorView,
      source: string,
      owner: Lease,
      immediate: boolean,
      expectedScope: Scope,
    ) => {
      const next = ++owner.generation
      owner.compiled = null
      owner.refreshPending = false
      latestSource.current = source
      window.clearTimeout(timer.current)
      setState({ kind: 'checking' })
      const current = () => owner.current() && owner.generation === next
      // Source changes arrive inside CodeMirror's update listener, which cannot
      // dispatch another transaction until the current one has finished.
      queueMicrotask(() => {
        if (current()) clear(target, expectedScope)
      })
      const refreshInvalidatedOwner = (error: unknown) => {
        if (!current()) return
        const message = errorMessage(error)
        if (!/MDX (?:context changed|lease unavailable|compile cancelled)/i.test(message)) {
          setState({ kind: 'unavailable', message })
          return
        }
        const key = `${expectedScope.sourceRevision}\u0000${source}`
        if (refreshAttempt.current === key) {
          setState({ kind: 'unavailable', message })
          return
        }
        refreshAttempt.current = key
        setState({ kind: 'checking' })
        setOwnershipRevision((revision) => revision + 1)
      }
      void trpc.mdxTrust.cancelCompile
        .mutate({ lease: owner.id, generation: next })
        .then(
          () => true,
          (error: unknown) => {
            if (current()) refreshInvalidatedOwner(error)
            return false
          },
        )
        .then((cancelled) => {
          if (!cancelled || !current()) return
          timer.current = window.setTimeout(
            () => {
              void trpc.mdxTrust.compile
                .mutate({ lease: owner.id, generation: next, source })
                .then((diagnostics) => {
                  if (!current() || !target.dom.isConnected) return
                  const mapped = diagnostics.map((diagnostic) => mapDiagnostic(target, diagnostic))
                  target.dispatch(setDiagnostics(target.state, mapped))
                  setState(
                    mapped.length ? { kind: 'syntax-error', diagnostics } : { kind: 'clean' },
                  )
                  owner.compiled = next
                  void readResources(owner)
                })
                .catch((error: unknown) => refreshInvalidatedOwner(error))
            },
            immediate ? 0 : DEBOUNCE_MS,
          )
        })
    },
    [clear, readResources],
  )

  const flushDiagnosticsRefresh = useCallback(
    (owner: Lease) => {
      if (!owner.refreshPending || !owner.current()) return
      // A push can already be in flight when main admits an unrelated approval.
      // Refresh grants now, but don't retire its offer until the decision settles.
      if ([...deciding.current.values()].some(attemptCurrent)) return
      const currentScope = renderedScope.current
      if (currentScope.view && latestSource.current !== null)
        schedule(currentScope.view, latestSource.current, owner, false, currentScope)
    },
    [schedule],
  )

  useEffect(() => {
    const eligible = Boolean(
      view && remote && /^.+\.mdx$/i.test(path) && visible && trusted && context && scope.vaultOpen,
    )
    const id = ++lifetime.current
    clear(ownerScope.current?.view ?? null, ownerScope.current)
    ownerScope.current = scope
    active.current = true
    latestSource.current = eligible && view ? view.state.doc.toString() : null
    setResources(null)
    deciding.current.clear()
    setDecisions([])
    setDecisionErrors([])
    window.clearTimeout(timer.current)
    clear(view, scope)
    if (!eligible || !view || !remote || !context) {
      setState({
        kind: 'unavailable',
        message: !visible
          ? 'MDX diagnostics pause while this view is hidden.'
          : 'Approve this vault to check MDX syntax.',
      })
      const old = lease.current
      lease.current = null
      ownerScope.current = null
      if (old)
        void trpc.mdxTrust.releaseDiagnosticsLease.mutate({ lease: old.id }).catch(() => undefined)
      return () => {
        active.current = false
      }
    }

    let released = false
    const release = (value: string) => {
      if (released) return
      released = true
      void trpc.mdxTrust.releaseDiagnosticsLease.mutate({ lease: value }).catch(() => undefined)
    }
    setState({ kind: 'checking' })
    void trpc.mdxTrust.acquireDiagnosticsLease
      .mutate({ remote, path, context })
      .then(({ lease: acquired }) => {
        if (
          !active.current ||
          lifetime.current !== id ||
          latestSource.current === null ||
          renderedScope.current !== scope ||
          !scope.identityCurrent()
        ) {
          release(acquired)
          return
        }
        const owner: Lease = {
          id: acquired,
          current: () =>
            active.current &&
            lifetime.current === id &&
            lease.current === owner &&
            renderedScope.current === scope &&
            ownerScope.current === scope &&
            scope.identityCurrent(),
          generation: 0,
          compiled: null,
          query: 0,
          refreshPending: false,
        }
        lease.current = owner
        schedule(view, latestSource.current, owner, false, scope)
        void readResources(owner)
      })
      .catch((error: unknown) => {
        if (
          active.current &&
          lifetime.current === id &&
          renderedScope.current === scope &&
          scope.identityCurrent()
        )
          setState({
            kind: 'unavailable',
            message: errorMessage(error),
          })
      })
    return () => {
      active.current = false
      window.clearTimeout(timer.current)
      clear(view, scope)
      const current = lease.current
      lease.current = null
      if (current) release(current.id)
    }
    // `view` identity intentionally scopes lease; new editors receive new leases.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, clear, schedule, readResources, retryRevision, ownershipRevision])

  useEffect(() => {
    if (!remote || !trusted || !visible || !view) return
    return window.holi?.plugin?.on(MDX_RESOURCE_EVENTS, (event) => {
      if (event.name !== 'changed' || event.remote !== remote.toLowerCase()) return
      const owner = lease.current
      if (!owner?.current() || renderedScope.current !== scope || latestSource.current === null)
        return
      owner.refreshPending = true
      flushDiagnosticsRefresh(owner)
      void readResources(owner)
    })
  }, [remote, trusted, visible, view, scope, flushDiagnosticsRefresh, readResources])

  const sourceChanged = useCallback(
    (target: EditorView, source: string) => {
      const currentScope = renderedScope.current
      if (
        ownerScope.current !== currentScope ||
        currentScope.view !== target ||
        !currentScope.vaultOpen ||
        !currentScope.identityCurrent()
      )
        return
      setRenderedSourceVersion(++sourceVersion.current)
      latestSource.current = source
      const owner = lease.current
      if (!owner?.current()) return
      schedule(target, source, owner, false, currentScope)
    },
    [schedule],
  )

  function retry() {
    if (ownerScope.current !== scope || !scope.identityCurrent()) return
    dismissed.current = null
    refreshAttempt.current = ''
    const owner = lease.current
    if (view && owner?.current() && latestSource.current !== null) {
      schedule(view, latestSource.current, owner, true, scope)
      void readResources(owner)
    } else {
      setState({ kind: 'checking' })
      setRetryRevision((value) => value + 1)
    }
  }

  const enabled = trusted && visible && scope.vaultOpen
  const currentState: MdxCompileState = !enabled
    ? {
        kind: 'unavailable',
        message: visible
          ? 'Approve this vault to check MDX syntax.'
          : 'MDX diagnostics pause while this view is hidden.',
      }
    : ownerScope.current === scope || !view
      ? state
      : { kind: 'checking' }
  const owner = lease.current
  const currentResources = owner?.current() && resources?.owner === owner ? resources : null
  const approved = currentResources?.approved ?? []
  const pendingSnapshot = currentResources?.pending
  const pendingCurrent = () =>
    owner?.current() &&
    pendingSnapshot?.generation === owner.generation &&
    pendingSnapshot.query === owner.query
  const pending = pendingCurrent()
    ? (pendingSnapshot?.items ?? []).filter(
        ({ origin }) =>
          dismissed.current?.identity !== identity || !dismissed.current.origins.has(origin),
      )
    : []
  const updatingOrigins = decisions.filter(attemptCurrent).map(({ origin }) => origin)
  const queryError =
    currentResources?.error && owner
      ? { message: currentResources.error, retry: () => void readResources(owner) }
      : null
  // A diagnostic rerun can replace offers; a failure still belongs to the
  // origin and source that the user reviewed (or to the lease for revocation).
  const errors = decisionErrors.filter(({ attempt }) => decisionErrorCurrent(attempt))

  function decisionErrorCurrent(attempt: DecisionAttempt) {
    return (
      attempt.owner.current() &&
      (attempt.action === 'revoke' || attempt.sourceVersion === sourceVersion.current)
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
    attempt.owner.refreshPending = true
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
      sourceVersion: sourceVersion.current,
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
      } else if (action === 'allow') {
        await trpc.mdxTrust.approveExternalResource.mutate({ lease: owner.id, requestId: id })
        if (attemptCurrent(attempt)) owner.refreshPending = true
      } else {
        await trpc.mdxTrust.revokeExternalResource.mutate({ lease: owner.id, grantId: id })
        if (attemptCurrent(attempt)) owner.refreshPending = true
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
    state: currentState,
    sourceChanged,
    retry,
    resources: enabled
      ? {
          approved,
          pending,
          loading: currentState.kind === 'checking' || currentResources?.loading === true,
          queryError,
          decisionErrors: errors.map(({ attempt, message }) => ({
            origin: attempt.origin,
            message: `${attempt.origin}: ${message}`,
            retry: () => retryDecision(attempt),
          })),
          diagnosticsError: currentState.kind === 'unavailable' ? currentState.message : null,
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

function mapDiagnostic(view: EditorView, diagnostic: MdxDiagnostic) {
  const lineNumber = Number.isFinite(diagnostic.line)
    ? Math.max(1, Math.min(Math.trunc(diagnostic.line), view.state.doc.lines))
    : 1
  const column = Number.isFinite(diagnostic.column) ? Math.max(1, Math.trunc(diagnostic.column)) : 1
  const line = view.state.doc.line(lineNumber)
  const from = Math.min(line.from + column - 1, line.to)
  return {
    from,
    to: Math.min(from + 1, line.to),
    severity: 'error' as const,
    message: diagnostic.message,
  }
}
