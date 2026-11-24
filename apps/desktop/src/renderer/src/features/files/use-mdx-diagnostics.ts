import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  MDX_RESOURCE_EVENTS,
  type MdxCompileState,
  type MdxDiagnostic,
  type MdxExternalResourceState,
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
type Run = { current: () => boolean; readResources: () => Promise<void>; lease: string }
type Resources =
  | { kind: 'loading' }
  | { kind: 'ready'; result: MdxExternalResourceState }
  | { kind: 'error'; message: string }
type Decision = 'allow' | 'deny' | 'revoke'

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
  const lease = useRef<string | null>(null)
  const generation = useRef(0)
  const lifetime = useRef(0)
  const timer = useRef<number | undefined>(undefined)
  const latestSource = useRef<string | null>(null)
  const active = useRef(true)
  const refreshAttempt = useRef('')
  const [resources, setResources] = useState<{ run: Run; load: Resources } | null>(null)
  const sourceVersion = useRef(0)
  const [renderedSourceVersion, setRenderedSourceVersion] = useState(0)
  const visit = useMemo(
    () => ({ scope, ownershipRevision, renderedSourceVersion }),
    [scope, ownershipRevision, renderedSourceVersion],
  )
  const [decision, setDecision] = useState<{
    ticket: object
    visit: object
    message?: string
  } | null>(null)
  const deciding = useRef<{ ticket: object; scope: Scope; sourceVersion: number } | null>(null)
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

  const schedule = useCallback(
    (
      target: EditorView,
      source: string,
      owner: number,
      currentLease: string,
      immediate: boolean,
      expectedScope: Scope,
    ) => {
      const next = ++generation.current
      latestSource.current = source
      window.clearTimeout(timer.current)
      setState({ kind: 'checking' })
      const current = () =>
        active.current &&
        lifetime.current === owner &&
        generation.current === next &&
        latestSource.current === source &&
        lease.current === currentLease &&
        renderedScope.current === expectedScope &&
        ownerScope.current === expectedScope &&
        expectedScope.identityCurrent()
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
      const job: Run = {
        current,
        lease: currentLease,
        async readResources() {
          if (!current()) return
          setResources({ run: job, load: { kind: 'loading' } })
          try {
            const result = await trpc.mdxTrust.externalResources.query({ lease: currentLease })
            if (!current()) return
            const load: Resources =
              result.generation === next
                ? { kind: 'ready', result }
                : {
                    kind: 'error',
                    message: 'The diagnostics changed. Run them again to review resources.',
                  }
            setResources({ run: job, load })
          } catch (error) {
            if (current())
              setResources({ run: job, load: { kind: 'error', message: errorMessage(error) } })
          }
        },
      }
      setResources({ run: job, load: { kind: 'loading' } })
      void trpc.mdxTrust.cancelCompile
        .mutate({ lease: currentLease, generation: next })
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
                .mutate({ lease: currentLease, generation: next, source })
                .then((diagnostics) => {
                  if (!current() || !target.dom.isConnected) return
                  const mapped = diagnostics.map((diagnostic) => mapDiagnostic(target, diagnostic))
                  target.dispatch(setDiagnostics(target.state, mapped))
                  setState(
                    mapped.length ? { kind: 'syntax-error', diagnostics } : { kind: 'clean' },
                  )
                  void job.readResources()
                })
                .catch((error: unknown) => refreshInvalidatedOwner(error))
            },
            immediate ? 0 : DEBOUNCE_MS,
          )
        })
    },
    [clear],
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
    generation.current = 0
    setResources(null)
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
        void trpc.mdxTrust.releaseDiagnosticsLease.mutate({ lease: old }).catch(() => undefined)
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
        lease.current = acquired
        schedule(view, latestSource.current, id, acquired, false, scope)
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
      if (current) release(current)
    }
    // `view` identity intentionally scopes lease; new editors receive new leases.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, clear, schedule, retryRevision, ownershipRevision])

  useEffect(() => {
    if (!remote || !trusted || !visible || !view) return
    return window.holi?.plugin?.on(MDX_RESOURCE_EVENTS, (event) => {
      if (event.name !== 'changed' || event.remote !== remote.toLowerCase()) return
      const currentLease = lease.current
      if (
        ownerScope.current !== scope ||
        renderedScope.current !== scope ||
        !active.current ||
        !scope.identityCurrent()
      )
        return
      if (currentLease && latestSource.current !== null)
        schedule(view, latestSource.current, lifetime.current, currentLease, false, scope)
    })
  }, [remote, trusted, visible, view, scope, schedule])

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
      const currentLease = lease.current
      if (!currentLease) return
      schedule(target, source, lifetime.current, currentLease, false, currentScope)
    },
    [schedule],
  )

  function retry() {
    if (ownerScope.current !== scope || !scope.identityCurrent()) return
    dismissed.current = null
    setDecision(null)
    refreshAttempt.current = ''
    const currentLease = lease.current
    if (view && currentLease && latestSource.current !== null) {
      schedule(view, latestSource.current, lifetime.current, currentLease, true, scope)
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
  const currentResources = resources?.run.current() ? resources.load : null
  const currentDecision = decision?.visit === visit ? decision : null
  const pendingDecision = currentDecision !== null && currentDecision.message === undefined
  const load: Resources = currentDecision?.message
    ? { kind: 'error', message: currentDecision.message }
    : currentState.kind === 'unavailable'
      ? { kind: 'error', message: currentState.message }
      : (currentResources ?? { kind: 'loading' })
  const pending =
    load.kind === 'ready'
      ? load.result.pending.filter(
          ({ origin }) =>
            dismissed.current?.identity !== identity || !dismissed.current.origins.has(origin),
        )
      : []

  async function decide(action: Decision, id: string) {
    const job = resources?.run
    if (!job?.current() || load.kind !== 'ready') return
    const existing = deciding.current
    const version = sourceVersion.current
    if (existing?.scope === scope && existing.sourceVersion === version) return
    const item = (action === 'revoke' ? load.result.approved : pending).find(
      (item) => item.id === id,
    )
    if (!item) return
    const ticket = {}
    const owner = lifetime.current
    const stillHere = () =>
      active.current &&
      lifetime.current === owner &&
      renderedScope.current === scope &&
      sourceVersion.current === version &&
      scope.identityCurrent()
    deciding.current = { ticket, scope, sourceVersion: version }
    setDecision({ ticket, visit })
    try {
      if (action === 'deny') {
        await trpc.mdxTrust.rejectExternalResource.mutate({ lease: job.lease, requestId: id })
        if (!stillHere()) return
        if (dismissed.current?.identity !== identity)
          dismissed.current = { identity, origins: new Set() }
        dismissed.current.origins.add(item.origin)
        if (job.current()) await job.readResources()
      } else {
        if (action === 'allow') {
          await trpc.mdxTrust.approveExternalResource.mutate({ lease: job.lease, requestId: id })
        } else {
          await trpc.mdxTrust.revokeExternalResource.mutate({ lease: job.lease, grantId: id })
        }
        // The event normally starts the refresh, including in other splits.
        // If this reply arrives first, don't leave the clicked controls live.
        if (job.current() && view && latestSource.current !== null)
          schedule(view, latestSource.current, owner, job.lease, false, scope)
      }
      setDecision((previous) => (previous?.ticket === ticket ? null : previous))
    } catch (error) {
      // Revocation invalidates all splits before persistence finishes; report
      // a failure even if the push has already started a new generation here.
      if (stillHere() && (job.current() || action === 'revoke'))
        setDecision({ ticket, visit, message: errorMessage(error) })
      else setDecision((previous) => (previous?.ticket === ticket ? null : previous))
    } finally {
      if (deciding.current?.ticket === ticket) deciding.current = null
    }
  }

  return {
    state: currentState,
    sourceChanged,
    retry,
    resources: enabled
      ? {
          load:
            load.kind === 'ready'
              ? { kind: 'ready' as const, pending, approved: load.result.approved }
              : load,
          pendingDecision,
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
