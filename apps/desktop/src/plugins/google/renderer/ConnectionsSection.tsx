/**
 * The Connections section of the settings tab: the Google account behind mail
 * and calendar. The plugin contributes it as a settings section.
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
 * **Whether an account is connected lives in `account.ts`, not here**, because
 * the nav menu shows Mail and Agenda on the same answer. Only the flow's
 * transient state is local, and every change here asks main again
 * (`refreshGoogle`) rather than assuming what it produced.
 */
import { useAtomValue } from 'jotai'
import { useEffect, useRef, useState } from 'react'
import { FormField, SettingsHeading, SettingsLink, SettingsNote } from '@/composites'
import { activeRemoteAtom } from '@/plugin-api'
import { Button, Input } from '@/primitives'
import type { GoogleClientSource } from '../main/credentials'
import { googleCap, useGoogleAccount } from './account'
import { useAlwaysAllowedSenders, useForgetImageSenders } from './mail-images'

/** The OAuth client in use, as main reports it: never its secret. */
interface GoogleClientInfo {
  id: string
  source: GoogleClientSource
}

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
  /** The OAuth client this machine connects with; null until main answers. */
  const [client, setClient] = useState<GoogleClientInfo | null>(null)
  const [clientVersion, setClientVersion] = useState(0)

  useEffect(() => {
    return () => {
      if (connecting.current !== null) void googleCap.cancelConnect(connecting.current)
    }
  }, [])

  useEffect(() => {
    if (remote === null) return
    let live = true
    googleCap
      .client(remote)
      .then((next) => {
        if (live) setClient(next)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [remote, clientVersion])

  const connect = async () => {
    if (remote === null) return
    setPhase({ kind: 'connecting' })
    connecting.current = remote
    try {
      await googleCap.connect(remote)
      // Settles when the browser comes back, the person cancels, or the flow
      // times out: there is no IPC timeout to race.
      const result = await googleCap.awaitConnect(remote)
      if (result.kind === 'granted') {
        // Re-read what was actually granted: a person can approve Gmail and
        // decline contacts, which lands here as `granted` with scopes still
        // missing. The nav menu's items appear when the answer does.
        refreshGoogle()
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
    refreshGoogle()
    setPhase({ kind: 'idle' })
  }

  /** Reuse an account already connected here. No consent: the grant exists. */
  const linkAccount = async (sub: string) => {
    if (remote !== null) await googleCap.useAccount(remote, { sub }).catch(() => undefined)
    refreshGoogle()
  }

  /** Revoke at Google and drop it everywhere. The destructive one. */
  const removeAccount = async (sub: string) => {
    if (remote !== null) await googleCap.removeAccount(remote, { sub }).catch(() => undefined)
    refreshGoogle()
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
          {/* Google refuses an outside account in the browser and never
              redirects back, so Holi cannot see it happen: say it while the
              browser is open and after a connect that came to nothing. */}
          {!connected &&
            client?.source === 'shipped' &&
            (phase.kind === 'connecting' || phase.error !== undefined) && (
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                If Google answers Error 403: org_internal, your account is outside syv.ai: use your
                own OAuth client below.
              </p>
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
                <Button size="xs" variant="secondary" onClick={() => void linkAccount(other.sub)}>
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
      {client !== null && (
        <OAuthClient
          client={client}
          accountCount={accounts.length}
          onChanged={() => {
            setClientVersion((v) => v + 1)
            refreshGoogle()
          }}
        />
      )}
    </section>
  )
}

/** Where Google's Desktop app clients are made. */
const CREDENTIALS_URL = 'https://console.cloud.google.com/apis/credentials'

/** Who the client in use is, in a sentence. */
function clientLabel(client: GoogleClientInfo): string {
  if (client.source === 'own') return `Your own client, ${client.id}.`
  if (client.source === 'environment') return 'The client in HOLI_GOOGLE_CLIENT_ID.'
  return 'Holi’s client, which accepts syv.ai accounts only.'
}

/**
 * The OAuth client this machine connects with: Holi's, or one the person
 * brings because Holi's is Internal to syv.ai.
 *
 * **Machine-wide, unlike the rest of the section**, because the accounts it
 * connects are. Saving a different client disconnects every account here
 * (their grants belong to the old one), so the form says so before the press,
 * on the button itself.
 */
function OAuthClient({
  client,
  accountCount,
  onChanged,
}: {
  client: GoogleClientInfo
  accountCount: number
  onChanged: () => void
}): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const [editing, setEditing] = useState(false)
  const [id, setId] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const close = () => {
    setEditing(false)
    setId('')
    setSecret('')
    setError(undefined)
  }

  const save = async (next: { id: string; secret: string }) => {
    if (remote === null) return
    setBusy(true)
    try {
      await googleCap.setClient(remote, next)
      close()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the client.')
    } finally {
      setBusy(false)
    }
  }

  /** "and disconnect 2 accounts": the cost, named on the button that pays it. */
  const cost =
    accountCount === 0
      ? ''
      : ` and disconnect ${accountCount} ${accountCount === 1 ? 'account' : 'accounts'}`

  if (!editing) {
    return (
      <div className="mt-3 flex items-baseline gap-2">
        <SettingsNote className="min-w-0 flex-1">
          <span className="text-foreground">OAuth client:</span> {clientLabel(client)}
        </SettingsNote>
        <Button variant="ghost" size="xs" className="shrink-0" onClick={() => setEditing(true)}>
          {client.source === 'own' ? 'Change client…' : 'Use your own client…'}
        </Button>
      </div>
    )
  }

  return (
    <div className="mt-3 space-y-2 rounded-md bg-muted/40 p-3">
      <SettingsNote>
        Make an OAuth client of type Desktop app in{' '}
        <SettingsLink onClick={() => void window.holi.openExternal(CREDENTIALS_URL)}>
          Google Cloud
        </SettingsLink>
        , with the Gmail, Google Calendar and People APIs enabled. Kept on this machine only.
      </SettingsNote>
      <FormField label="Client ID">
        <Input
          value={id}
          placeholder="123-abc.apps.googleusercontent.com"
          spellCheck={false}
          onChange={(e) => setId(e.target.value)}
        />
      </FormField>
      <FormField label="Client secret">
        <Input
          type="password"
          value={secret}
          spellCheck={false}
          onChange={(e) => setSecret(e.target.value)}
        />
      </FormField>
      {error !== undefined && <p className="text-[11px] text-destructive">{error}</p>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {client.source === 'own' && (
          <Button
            variant="ghost"
            size="xs"
            disabled={busy}
            onClick={() => void save({ id: '', secret: '' })}
          >
            {`Use Holi’s client${cost}`}
          </Button>
        )}
        <Button variant="ghost" size="xs" disabled={busy} onClick={close}>
          Cancel
        </Button>
        <Button
          size="xs"
          disabled={busy || id.trim() === '' || secret.trim() === ''}
          onClick={() => void save({ id, secret })}
        >
          {`Save${cost}`}
        </Button>
      </div>
    </div>
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
