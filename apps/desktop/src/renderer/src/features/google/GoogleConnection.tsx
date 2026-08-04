/**
 * Connect / disconnect the Google account behind mail + calendar (D67).
 *
 * **Account-wide, not per-vault.** It renders inside vault settings because
 * that is the only settings surface today, so the copy says so plainly rather
 * than letting its position imply a scope it does not have.
 *
 * The two-phase shape mirrors `SignIn`: `connect` returns as soon as the
 * browser is open, `awaitConnect` resolves when the grant lands. Nothing here
 * ever sees a token — the renderer is handed an email address and nothing else.
 */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/primitives'
import { trpc } from '../../lib/trpc'

type State =
  | { kind: 'loading' }
  | { kind: 'disconnected'; error?: string }
  | { kind: 'connecting' }
  | { kind: 'connected'; email: string }

/** What a non-granted outcome should say. Each is a normal thing that happens,
 *  so none of them are phrased as errors. */
const OUTCOME: Record<string, string> = {
  denied: 'You cancelled the Google consent.',
  timeout: 'The connection timed out. Try again.',
  cancelled: '',
}

export function GoogleConnection() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  /** Set while a connect is in flight, so unmounting cancels it rather than
   *  leaving a listener holding a port for the life of the app. */
  const connecting = useRef(false)

  useEffect(() => {
    void trpc.google.status
      .query()
      .then(({ account }) =>
        setState(account === null ? { kind: 'disconnected' } : { kind: 'connected', email: account.email }),
      )
      // The connector is unconfigured (no client id yet) — not an error state
      // the user can act on, so it reads as simply not connected.
      .catch(() => setState({ kind: 'disconnected' }))

    return () => {
      if (connecting.current) void trpc.google.cancelConnect.mutate()
    }
  }, [])

  const connect = async () => {
    setState({ kind: 'connecting' })
    connecting.current = true
    try {
      await trpc.google.connect.mutate()
      const result = await trpc.google.awaitConnect.mutate()
      if (result.kind === 'granted' && result.account !== null) {
        setState({ kind: 'connected', email: result.account.email })
      } else {
        setState({ kind: 'disconnected', error: OUTCOME[result.kind] || undefined })
      }
    } catch (err) {
      setState({
        kind: 'disconnected',
        error: err instanceof Error ? err.message : 'Could not connect to Google.',
      })
    } finally {
      connecting.current = false
    }
  }

  const disconnect = async () => {
    await trpc.google.disconnect.mutate().catch(() => undefined)
    setState({ kind: 'disconnected' })
  }

  return (
    <section className="space-y-2">
      <h3 className="font-medium">Google</h3>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-xs text-muted-foreground">
            {state.kind === 'connected' ? (
              <>
                Connected as <span className="text-foreground">{state.email}</span>
              </>
            ) : state.kind === 'connecting' ? (
              'Waiting for your browser…'
            ) : (
              'Read your Gmail and Calendar. Applies to every vault.'
            )}
          </p>
          {state.kind === 'disconnected' && state.error !== undefined && (
            <p className="mt-0.5 truncate text-xs text-amber-400">{state.error}</p>
          )}
        </div>

        {state.kind === 'connected' ? (
          <Button variant="secondary" size="sm" className="shrink-0" onClick={() => void disconnect()}>
            Disconnect
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            disabled={state.kind === 'connecting' || state.kind === 'loading'}
            onClick={() => void connect()}
          >
            {state.kind === 'connecting' ? 'Connecting…' : 'Connect'}
          </Button>
        )}
      </div>
      {state.kind === 'connected' && (
        <p className="text-xs text-muted-foreground">
          Read-only. Holi cannot send mail or change your calendar.
        </p>
      )}
    </section>
  )
}
