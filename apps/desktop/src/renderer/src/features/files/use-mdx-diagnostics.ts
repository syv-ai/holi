import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MdxCompileState, MdxDiagnostic } from '@holi/shared'
import { setDiagnostics } from '@codemirror/lint'
import type { EditorView } from '@codemirror/view'
import { trpc } from '@/lib/trpc'

const DEBOUNCE_MS = 300

type Scope = {
  view: EditorView | null
  remote: string | null
  path: string
  context: string | null
  trusted: boolean
  visible: boolean
  sourceRevision: number
}

/** Owns one isolated main-process diagnostic lease for this visible editor. */
export function useMdxDiagnostics(input: Scope) {
  const { view, remote, path, context, trusted, visible, sourceRevision } = input
  const scope = useMemo(
    () => ({ view, remote, path, context, trusted, visible, sourceRevision }),
    [view, remote, path, context, trusted, visible, sourceRevision],
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
      clear(target, expectedScope)
      setState({ kind: 'checking' })
      const current = () =>
        active.current &&
        lifetime.current === owner &&
        generation.current === next &&
        latestSource.current === source &&
        lease.current === currentLease &&
        renderedScope.current === expectedScope &&
        ownerScope.current === expectedScope
      const refreshInvalidatedOwner = (error: unknown) => {
        if (!current()) return
        const message = error instanceof Error ? error.message : String(error)
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
      view && remote && /^.+\.mdx$/i.test(path) && visible && trusted && context,
    )
    const id = ++lifetime.current
    clear(ownerScope.current?.view ?? null, ownerScope.current)
    ownerScope.current = scope
    active.current = true
    latestSource.current = eligible && view ? view.state.doc.toString() : null
    generation.current = 0
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
          renderedScope.current !== scope
        ) {
          release(acquired)
          return
        }
        lease.current = acquired
        schedule(view, latestSource.current, id, acquired, false, scope)
      })
      .catch((error: unknown) => {
        if (active.current && lifetime.current === id && renderedScope.current === scope)
          setState({
            kind: 'unavailable',
            message: error instanceof Error ? error.message : String(error),
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

  const sourceChanged = useCallback(
    (target: EditorView, source: string) => {
      const currentScope = renderedScope.current
      if (ownerScope.current !== currentScope) return
      latestSource.current = source
      clear(target, currentScope)
      setState({ kind: 'checking' })
      const currentLease = lease.current
      if (!currentLease) return
      schedule(target, source, lifetime.current, currentLease, false, currentScope)
    },
    [clear, schedule],
  )

  const retry = useCallback(() => {
    setState({ kind: 'checking' })
    setRetryRevision((revision) => revision + 1)
  }, [])

  return { state, sourceChanged, retry }
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
