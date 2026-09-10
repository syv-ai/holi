/**
 * The Connections section: the Google account behind mail + calendar (D67).
 *
 * **Lives under `features/settings/`, not `features/google/`, because a feature
 * may only import primitives, composites and itself.** It was previously
 * composed into the legacy vault panel by the shell as a `connections` prop,
 * which is the workaround that injection existed for. With the settings tab
 * owning every settings surface it is simply one of the sections, and the shell
 * no longer has to know it exists. The mail and agenda views are unaffected:
 * nothing here is shared with them but `state/google.ts`, which is not a
 * feature.
 *
 * **Two scopes, and the panel's job is keeping them apart** (D87). An account is
 * connected on this *machine*; a *vault* uses one of them. So the rows offer
 * the machine's accounts, the connect button's label follows that list, and
 * every act here — using, unlinking — is this vault's alone except "Remove from
 * Holi", which is the machine's.
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
import { SettingsHeading, SettingsNote } from './settings-ui'
import { useGoogleAccount } from '@/state/google'
import { useAlwaysAllowedSenders, useForgetImageSenders } from '@/state/mail-images'
import { trpc } from '@/lib/trpc'

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

export function ConnectionsSection(): React.JSX.Element {
  const {
    account,
    setAccount,
    missingScopes,
    accounts,
    currentSub,
    refresh: refreshGoogle,
  } = useGoogleAccount()
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

  /** Unlink THIS vault. The account and every other vault using it survive. */
  const disconnect = async () => {
    await trpc.google.disconnectVault.mutate().catch(() => undefined)
    setAccount(null)
    void refreshGoogle()
    setPhase({ kind: 'idle' })
  }

  /** Reuse an account already connected here. No consent: the grant exists. */
  const useAccount = async (sub: string) => {
    await trpc.google.useAccount.mutate({ sub }).catch(() => undefined)
    setAccount(undefined) // back to "not asked", so the shell re-reads with it
    void refreshGoogle()
  }

  /** Revoke at Google and drop it everywhere. The destructive one. */
  const removeAccount = async (sub: string) => {
    await trpc.google.removeAccount.mutate({ sub }).catch(() => undefined)
    setAccount(undefined)
    void refreshGoogle()
  }

  /** Connected here, but not the one this vault uses. */
  const others = accounts.filter((a) => a.sub !== currentSub)

  /**
   * The connect button's label follows the **machine** list, not this vault's
   * link (D87). "A different account" is only a sensible thing to offer when
   * there is an account here to differ from; on a first run there is none, and
   * naming one the user does not have is how the two scopes get confused. While
   * the answer is still being asked for, `accounts` is empty and the button is
   * disabled, so the plain label is also the safe one.
   */
  const connectLabel = accounts.length > 0 ? 'Connect a different account…' : 'Connect'

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
    <section>
      <SettingsHeading title="Google" />
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[11px] text-muted-foreground">
            {connected ? (
              <>
                Connected as <span className="text-foreground">{account.email}</span>
              </>
            ) : phase.kind === 'connecting' ? (
              'Waiting for your browser…'
            ) : (
              'Read and triage your Gmail, read your Calendar. This vault only.'
            )}
          </p>
          {!connected && phase.kind === 'idle' && phase.error !== undefined && (
            <p className="mt-0.5 truncate text-[11px] text-amber-400">{phase.error}</p>
          )}
        </div>

        {connected ? (
          <div className="flex shrink-0 items-center gap-2">
            {needsReconsent && (
              <Button size="xs" disabled={busy} onClick={() => void connect()}>
                {phase.kind === 'connecting' ? 'Connecting…' : 'Reconnect'}
              </Button>
            )}
            <Button variant="secondary" size="xs" onClick={() => void disconnect()}>
              Disconnect this vault
            </Button>
          </div>
        ) : (
          <Button
            variant="secondary"
            size="xs"
            className="shrink-0"
            disabled={busy}
            onClick={() => void connect()}
          >
            {phase.kind === 'connecting' ? 'Connecting…' : connectLabel}
          </Button>
        )}
      </div>

      {/* Accounts connected on this machine that this vault is not using (D87).
          Picking one is a mapping, not a consent round trip, so it is one click
          and deliberately not dressed up as connecting. */}
      {others.length > 0 && (
        <ul className="mt-2 space-y-1">
          {others.map((other) => (
            <li key={other.sub} className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                {other.email}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <Button size="xs" variant="secondary" onClick={() => void useAccount(other.sub)}>
                  Use in this vault
                </Button>
                <Button size="xs" variant="ghost" onClick={() => void removeAccount(other.sub)}>
                  Remove from Holi
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {connected &&
        (needsReconsent ? (
          <p className="mt-2 text-[11px] text-amber-400">
            Holi needs new permissions. Mail still loads, but marking read, starring, archiving and
            contacts will not work until you reconnect.
          </p>
        ) : (
          <SettingsNote className="mt-2">
            Holi can read your mail and calendar, and mark read, star, archive or trash a thread. It
            cannot delete mail permanently or change your calendar.
          </SettingsNote>
        ))}
      {connected && <ImageSenders />}
    </section>
  )
}

/**
 * The standing "always load images from this sender" permissions.
 *
 * **Shown because it is revocable, and revocable because it is shown.** Every
 * one of these is a disclosure the user agreed to once, in a mail reader,
 * possibly months ago — a permission that cannot be seen or withdrawn from
 * settings is not one they can be said to still be giving. Absent entirely when
 * there are none, so the common case costs no words.
 */
function ImageSenders(): React.JSX.Element | null {
  const senders = useAlwaysAllowedSenders()
  const forget = useForgetImageSenders()

  if (senders === undefined || senders.size === 0) return null

  return (
    <p className="mt-2 flex items-baseline gap-2 text-[11px] text-muted-foreground">
      <span className="min-w-0 flex-1">
        Images load automatically from {senders.size}{' '}
        {senders.size === 1 ? 'sender' : 'senders'}.
      </span>
      <Button variant="ghost" size="xs" className="shrink-0" onClick={() => void forget()}>
        Forget them
      </Button>
    </p>
  )
}
