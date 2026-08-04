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
 *
 * **Whether an account is connected lives in `state/google.ts`, not here.** The
 * shell shows or hides the agenda and mail chips on the same answer, so a local
 * `useState` meant connecting left the chips missing until a reload. What stays
 * local is only the transient part of the flow — in flight, and what went
 * wrong — which nothing outside this panel has any use for.
 */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/primitives'
import { useGoogleAccount } from '../../state/google'
import { trpc } from '../../lib/trpc'

/** The flow's transient state. "Connected" is deliberately absent — that is the
 *  shared atom's to know. */
type Phase = { kind: 'idle'; error?: string } | { kind: 'connecting' }

/** What a non-granted outcome should say. Each is a normal thing that happens,
 *  so none of them are phrased as errors. */
const OUTCOME: Record<string, string> = {
  denied: 'You cancelled the Google consent.',
  timeout: 'The connection timed out. Try again.',
  cancelled: '',
}

export function GoogleConnection() {
  const [account, setAccount, missingScopes, refreshGoogle] = useGoogleAccount()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  /** Set while a connect is in flight, so unmounting cancels it rather than
   *  leaving a listener holding a port for the life of the app. */
  const connecting = useRef(false)

  useEffect(() => {
    return () => {
      if (connecting.current) void trpc.google.cancelConnect.mutate()
    }
  }, [])

  const connect = async () => {
    setPhase({ kind: 'connecting' })
    connecting.current = true
    try {
      await trpc.google.connect.mutate()
      const result = await trpc.google.awaitConnect.mutate()
      if (result.kind === 'granted' && result.account !== null) {
        // Writing the shared atom is what makes the shell's chips appear, on
        // the same tick this panel says "connected as". `refreshGoogle` then
        // re-reads what was actually granted rather than assuming consent was
        // taken whole — a user can approve Gmail and decline contacts, which
        // lands here as `granted` with scopes still missing.
        setAccount(result.account)
        void refreshGoogle()
        setPhase({ kind: 'idle' })
      } else {
        setPhase({ kind: 'idle', error: OUTCOME[result.kind] || undefined })
      }
    } catch (err) {
      setPhase({
        kind: 'idle',
        error: err instanceof Error ? err.message : 'Could not connect to Google.',
      })
    } finally {
      connecting.current = false
    }
  }

  const disconnect = async () => {
    await trpc.google.disconnect.mutate().catch(() => undefined)
    setAccount(null)
    void refreshGoogle()
    setPhase({ kind: 'idle' })
  }

  const connected = account != null
  const busy = phase.kind === 'connecting' || account === undefined
  /**
   * Connected, but on a grant older than the scopes this build needs.
   *
   * Worth its own affordance rather than an error on the feature that fails:
   * the mailbox still lists, so the user's evidence says Google works, and
   * "reconnect" is not a step anyone guesses from a triage button doing nothing.
   */
  const needsReconsent = connected && missingScopes.length > 0

  return (
    <section className="space-y-2">
      <h3 className="font-medium">Google</h3>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-xs text-muted-foreground">
            {connected ? (
              <>
                Connected as <span className="text-foreground">{account.email}</span>
              </>
            ) : phase.kind === 'connecting' ? (
              'Waiting for your browser…'
            ) : (
              'Read and triage your Gmail, read your Calendar. Applies to every vault.'
            )}
          </p>
          {!connected && phase.kind === 'idle' && phase.error !== undefined && (
            <p className="mt-0.5 truncate text-xs text-amber-400">{phase.error}</p>
          )}
        </div>

        {connected ? (
          <div className="flex shrink-0 items-center gap-2">
            {needsReconsent && (
              <Button size="sm" disabled={busy} onClick={() => void connect()}>
                {phase.kind === 'connecting' ? 'Connecting…' : 'Reconnect'}
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={() => void disconnect()}>
              Disconnect
            </Button>
          </div>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            disabled={busy}
            onClick={() => void connect()}
          >
            {phase.kind === 'connecting' ? 'Connecting…' : 'Connect'}
          </Button>
        )}
      </div>
      {connected &&
        (needsReconsent ? (
          <p className="text-xs text-amber-400">
            Holi needs new permissions. Mail still loads, but marking read, starring, archiving and
            contacts will not work until you reconnect.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Holi can read your mail and calendar, and mark read, star, archive or trash a thread. It
            cannot delete mail permanently or change your calendar.
          </p>
        ))}
    </section>
  )
}
