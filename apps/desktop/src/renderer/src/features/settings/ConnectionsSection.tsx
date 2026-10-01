/**
 * The Connections section: the Google account behind mail + calendar.
 *
 * **Lives under `features/settings/`, not `features/google/`, because a feature
 * may only import primitives, composites and itself.** It shares only
 * `state/google.ts` with the mail and agenda views.
 *
 * **Two scopes, and the panel's job is keeping them apart**. An account is
 * connected on this *machine*; a *vault* uses one of them. So the rows offer
 * the machine's accounts, the connect button's label follows that list, and
 * every act here — using, unlinking — is this vault's alone except "Remove from
 * Holi", which is the machine's.
 *
 * The two-phase shape mirrors `SignIn`: `connect` returns as soon as the
 * browser is open, `awaitConnect` resolves when the grant lands. Nothing here
 * ever sees a token: the renderer is handed an email address and nothing else.
 *
 * **Whether an account is connected lives in `state/google.ts`, not here**,
 * because the shell shows the agenda and mail chips on the same answer. Only
 * the flow's transient state is local.
 */
import { useAtomValue } from 'jotai'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/primitives'
import { SettingsHeading, SettingsNote } from './settings-ui'
import { googleCap, useGoogleAccount } from '@/state/google'
import { useAlwaysAllowedSenders, useForgetImageSenders } from '@/state/mail-images'
import { activeRemoteAtom } from '@/state/vaults'

/** The flow's transient state. "Connected" is deliberately absent: that is the
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
  const remote = useAtomValue(activeRemoteAtom)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  /** The vault a connect in flight is for, so unmounting cancels it rather
   *  than leaving a listener holding a port for the life of the app. */
  const connecting = useRef<string | null>(null)

  useEffect(() => {
    return () => {
      if (connecting.current !== null) void googleCap.cancelConnect(connecting.current)
    }
  }, [])

  const connect = async () => {
    if (remote === null) return
    setPhase({ kind: 'connecting' })
    connecting.current = remote
    try {
      await googleCap.connect(remote)
      // Settles when the browser comes back, the person cancels, or the flow
      // times out: there is no IPC timeout to race.
      const result = await googleCap.awaitConnect(remote)
      if (result.kind === 'granted' && result.account !== null) {
        // Writing the shared atom makes the shell's chips appear on the same
        // tick. `refreshGoogle` then re-reads what was actually granted: a user
        // can approve Gmail and decline contacts, which lands here as `granted`
        // with scopes still missing.
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
      connecting.current = null
    }
  }

  /** Unlink THIS vault. The account and every other vault using it survive. */
  const disconnect = async () => {
    if (remote !== null) await googleCap.disconnectVault(remote).catch(() => undefined)
    setAccount(null)
    void refreshGoogle()
    setPhase({ kind: 'idle' })
  }

  /** Reuse an account already connected here. No consent: the grant exists. */
  const useAccount = async (sub: string) => {
    if (remote !== null) await googleCap.useAccount(remote, { sub }).catch(() => undefined)
    setAccount(undefined) // back to "not asked", so the shell re-reads with it
    void refreshGoogle()
  }

  /** Revoke at Google and drop it everywhere. The destructive one. */
  const removeAccount = async (sub: string) => {
    if (remote !== null) await googleCap.removeAccount(remote, { sub }).catch(() => undefined)
    setAccount(undefined)
    void refreshGoogle()
  }

  /** Connected here, but not the one this vault uses. */
  const others = accounts.filter((a) => a.sub !== currentSub)

  /**
   * The connect button's label follows the **machine** list, not this vault's
   * link: "a different account" only makes sense when there is one here
   * to differ from. While `accounts` is loading it is empty and the button is
   * disabled, so the plain label is also the safe one.
   */
  const connectLabel = accounts.length > 0 ? 'Connect a different account…' : 'Connect'

  const connected = account != null
  const busy = phase.kind === 'connecting' || account === undefined
  /**
   * Connected, but on a grant older than the scopes this build needs.
   *
   * Its own affordance rather than an error on the feature that fails: the
   * mailbox still lists, so nobody would guess "reconnect" from a triage
   * button doing nothing.
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

      {/* Accounts connected on this machine that this vault is not using.
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
 * **Shown because it is revocable, and revocable because it is shown.** Each
 * was agreed to once in a mail reader, possibly months ago; a permission that
 * cannot be seen or withdrawn is not one still being given. Absent entirely
 * when there are none.
 */
function ImageSenders(): React.JSX.Element | null {
  const senders = useAlwaysAllowedSenders()
  const forget = useForgetImageSenders()

  if (senders === undefined || senders.size === 0) return null

  return (
    <p className="mt-2 flex items-baseline gap-2 text-[11px] text-muted-foreground">
      <span className="min-w-0 flex-1">
        Images load automatically from {senders.size} {senders.size === 1 ? 'sender' : 'senders'}.
      </span>
      <Button variant="ghost" size="xs" className="shrink-0" onClick={() => void forget()}>
        Forget them
      </Button>
    </p>
  )
}
