import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MdxCompileState, MdxDiagnostic } from '@holi/shared'
import { useAtomValue, useStore } from 'jotai'
import { setDiagnostics } from '@codemirror/lint'
import type { EditorView } from '@codemirror/view'
import { trpc } from '@/lib/trpc'
import { sessionAtom } from '@/state/session'
import { activeRemoteAtom, activeRemoteRevisionValueAtom, openedRemoteAtom } from '@/state/vaults'
import { useMdxResources } from './use-mdx-resources'

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
  compiledGeneration: number | null
  readonly sourceVersion: number
}

/** Owns the diagnostics lease and compile lifecycle for one visible source editor. */
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
  const sourceVersion = useRef(0)
  const [renderedSourceVersion, setRenderedSourceVersion] = useState(0)
  const visit = useMemo(
    () => ({ scope, ownershipRevision, renderedSourceVersion }),
    [scope, ownershipRevision, renderedSourceVersion],
  )
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
      owner: Lease,
      immediate: boolean,
      expectedScope: Scope,
    ) => {
      const next = ++owner.generation
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
        // Retire authority now, not when React next runs the lease effect.
        lifetime.current++
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
                  owner.compiledGeneration = next
                  setState(
                    mapped.length ? { kind: 'syntax-error', diagnostics } : { kind: 'clean' },
                  )
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
    const { view, remote, path, visible, trusted, context, vaultOpen } = scope
    const eligible = Boolean(
      view && remote && /^.+\.mdx$/i.test(path) && visible && trusted && context && vaultOpen,
    )
    const id = ++lifetime.current
    clear(ownerScope.current?.view ?? null, ownerScope.current)
    ownerScope.current = scope
    active.current = true
    latestSource.current = eligible && view ? view.state.doc.toString() : null
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
          compiledGeneration: null,
          get sourceVersion() {
            return sourceVersion.current
          },
        }
        lease.current = owner
        schedule(view, latestSource.current, owner, false, scope)
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
    // `scope` includes editor identity so a replacement view gets its own lease.
  }, [scope, clear, schedule, retryRevision, ownershipRevision])

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

  const currentOwner = useCallback(() => {
    const owner = lease.current
    return owner?.current() ? owner : null
  }, [])
  const requestCompile = useCallback(() => {
    const scope = renderedScope.current
    const owner = currentOwner()
    if (scope.view && owner && latestSource.current !== null)
      schedule(scope.view, latestSource.current, owner, false, scope)
  }, [currentOwner, schedule])

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
  const { model: resources, explicitRun } = useMdxResources({
    identity,
    visit,
    enabled,
    currentOwner,
    compileStatus: {
      checking: currentState.kind === 'checking',
      error: currentState.kind === 'unavailable' ? currentState.message : null,
    },
    requestCompile,
  })

  const retry = useCallback(() => {
    if (ownerScope.current !== scope || !scope.identityCurrent()) return
    refreshAttempt.current = ''
    const owner = currentOwner()
    if (view && owner && latestSource.current !== null) {
      schedule(view, latestSource.current, owner, true, scope)
    } else {
      setState({ kind: 'checking' })
      setRetryRevision((value) => value + 1)
    }
    explicitRun()
  }, [scope, view, currentOwner, schedule, explicitRun])

  return { state: currentState, sourceChanged, retry, resources }
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
