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
 *
 * Drawn as ReUI's settings-6: the service as a framed row with its mark on
 * the same tile the onboarding's plugin cards use (`IconTile`, `pluginMark`),
 * its state and one action, and what follows from connecting as muted rows
 * inside the same frame. Last, the OAuth client this machine connects with
 * (`OAuthClient`), Holi's or the person's own.
 */
import { useAtomValue } from 'jotai'
import { ImageIcon, ShieldCheckIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Frame, FramePanel } from '@/components/ui/frame'
import { ConfirmDialog } from '@/composites/confirm-dialog'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item'
import { IconTile } from '@/components/ui/icon-tile'
import { pluginMark } from '@/composites/marks'
import { activeRemoteAtom, withSavedBuffers } from '@/plugin-api'
import { googleCap } from './google-cap'
import { useGoogleAccount } from './account'
import { initialsOf } from './mail/data'
import { OAuthClient } from './oauth-client'
import { useAlwaysAllowedSenders, useForgetImageSenders } from './mail-images'

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

export function ConnectionsSection({ visible = true }: { visible?: boolean }): React.JSX.Element {
  const {
    account,
    loading,
    readError,
    missingScopes,
    needsReconnect,
    accounts,
    currentSub,
    refresh: refreshGoogle,
    refreshAndWait,
  } = useGoogleAccount()
  const remote = useAtomValue(activeRemoteAtom)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [lifecycleError, setLifecycleError] = useState<string | null>(null)
  const [changingAccount, setChangingAccount] = useState(false)
  /** The vault a connect in flight is for, so unmounting cancels it rather
   *  than leaving a listener holding a port for the life of the app. */
  const connecting = useRef<string | null>(null)
  const generation = useRef(0)
  const invalidateGeneration = () => {
    generation.current++
  }
  /** The account a "Remove from Holi" is asking about: it revokes at
   *  Google, so it is confirmed first. */
  const [removing, setRemoving] = useState<{ sub: string; email: string } | null>(null)

  useEffect(() => {
    if (!visible) {
      invalidateGeneration()
      const remote = connecting.current
      connecting.current = null
      if (remote !== null) void googleCap.cancelConnect(remote)
      setPhase({ kind: 'idle' })
      setRemoving(null)
    }
    return () => {
      invalidateGeneration()
      const remote = connecting.current
      connecting.current = null
      if (remote !== null) void googleCap.cancelConnect(remote)
    }
  }, [visible])

  const connect = async () => {
    if (remote === null) return
    const attempt = ++generation.current
    const ownsAttempt = () => generation.current === attempt
    setPhase({ kind: 'connecting' })
    connecting.current = remote
    try {
      await googleCap.connect(remote)
      if (!ownsAttempt()) return
      // Settles when the browser comes back, the person cancels, or the flow
      // times out: there is no IPC timeout to race.
      const result = await googleCap.awaitConnect(remote)
      if (!ownsAttempt()) return
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
      if (!ownsAttempt()) return
      setPhase({
        kind: 'idle',
        error: err instanceof Error ? err.message : 'Could not connect to Google.',
      })
    } finally {
      if (ownsAttempt()) connecting.current = null
    }
  }

  /** Unlink THIS vault. The account and every other vault using it survive. */
  const changeAccount = async (
    change: () => Promise<unknown>,
    showLifecycleError = true,
  ): Promise<string | null> => {
    setChangingAccount(true)
    setLifecycleError(null)
    let mutationStarted = false
    try {
      await withSavedBuffers(async () => {
        mutationStarted = true
        await change()
        await refreshAndWait()
      })
      return null
    } catch (err) {
      const detail = err instanceof Error ? ` ${err.message}` : ''
      const message = mutationStarted
        ? `Could not confirm the Google account change.${detail} Check the connection before retrying.`
        : `Could not save your mail draft, so the Google account was not changed.${detail} The current account remains connected. Save or copy the draft, then retry.`
      if (showLifecycleError) setLifecycleError(message)
      return message
    } finally {
      setChangingAccount(false)
    }
  }

  /** Unlink THIS vault. The account and every other vault using it survive. */
  const disconnect = async () => {
    if (remote === null) return
    await changeAccount(() => googleCap.disconnectVault(remote))
  }

  /** Reuse an account already connected here. No consent: the grant exists. */
  const linkAccount = async (sub: string) => {
    if (remote === null) return
    await changeAccount(() => googleCap.useAccount(remote, { sub }))
  }

  /**
   * Revoke at Google and drop it everywhere. The destructive one, and the only
   * one confirmed: unlinking this vault (Disconnect) is undone by "Use in this
   * vault", but a revoke takes mail and calendar from every vault using the
   * account and needs a fresh consent to get back.
   */
  const removeAccount = async (sub: string) => {
    if (remote === null) return
    if ((await changeAccount(() => googleCap.removeAccount(remote, { sub }))) === null)
      setRemoving(null)
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
  const busy = phase.kind === 'connecting' || loading || changingAccount
  /**
   * Connected, but on a grant older than the scopes this build needs.
   *
   * Its own affordance rather than an error on the feature that fails: the
   * mailbox still lists, so nobody would guess "reconnect" from a triage
   * button doing nothing.
   */
  const needsReconsent = connected && missingScopes.length > 0

  return (
    <Frame>
      <FramePanel>
        <div className="flex flex-col gap-2.5">
          <Item>
            <ItemMedia className="translate-y-0! self-center!">
              <IconTile>{pluginMark('google')}</IconTile>
            </ItemMedia>

            <ItemContent className="min-w-0">
              <ItemTitle>Google</ItemTitle>
              <ItemDescription className="break-words">
                {connected ? (
                  <>
                    Mail and Calendar, as <span className="text-foreground">{account.email}</span>
                  </>
                ) : phase.kind === 'connecting' ? (
                  'Waiting for your browser…'
                ) : needsReconnect ? (
                  'Google stopped accepting this connection. Connect again, or forget it.'
                ) : loading ? (
                  'Checking your Google connection…'
                ) : (
                  'Read and triage your Gmail, read your Calendar. This vault only.'
                )}
              </ItemDescription>
              {!connected && phase.kind === 'idle' && phase.error !== undefined && (
                <p role="alert" className="text-sm text-pretty text-destructive">
                  {phase.error}
                </p>
              )}
            </ItemContent>

            <ItemActions>
              {connected ? (
                <>
                  {needsReconsent && (
                    <Button size="sm" disabled={busy} onClick={() => void connect()}>
                      {phase.kind === 'connecting' ? 'Connecting…' : 'Reconnect'}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label="Disconnect this vault"
                    disabled={busy}
                    onClick={() => void disconnect()}
                  >
                    Disconnect
                  </Button>
                </>
              ) : (
                <>
                  <Button size="sm" disabled={busy} onClick={() => void connect()}>
                    {phase.kind === 'connecting' ? 'Connecting…' : connectLabel}
                  </Button>
                  {needsReconnect && (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label="Forget this connection"
                      disabled={busy}
                      onClick={() => void disconnect()}
                    >
                      Forget
                    </Button>
                  )}
                </>
              )}
            </ItemActions>
          </Item>

          {lifecycleError !== null && (
            <p role="alert" className="text-sm text-pretty text-destructive">
              {lifecycleError}
            </p>
          )}

          {readError && (
            <p role="alert" className="text-sm text-pretty text-destructive">
              Could not read the Google connection.{' '}
              <Button size="sm" variant="text" onClick={refreshGoogle}>
                Retry
              </Button>
            </p>
          )}

          {connected &&
            (needsReconsent ? (
              <Alert variant="destructive">
                <AlertTitle>Holi needs new permissions</AlertTitle>
                <AlertDescription>
                  Mail still loads, but marking read, starring, archiving and contacts will not work
                  until you reconnect.
                </AlertDescription>
              </Alert>
            ) : (
              <Item variant="muted">
                <ItemMedia variant="icon">
                  <ShieldCheckIcon />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>What Holi may do</ItemTitle>
                  <ItemDescription>
                    Read your mail and calendar, and mark read, star, archive or trash a thread. It
                    cannot delete mail permanently or change your calendar.
                  </ItemDescription>
                </ItemContent>
              </Item>
            ))}
          {connected && <ImageSenders />}

          {/* Accounts connected on this machine that this vault is not using.
              Picking one is a mapping, not a consent round trip, so it is one
              click and deliberately not dressed up as connecting. */}
          {others.map((other) => (
            <Item key={other.sub} variant="muted">
              <ItemMedia>
                <Avatar>
                  <AvatarFallback className="text-xs font-semibold">
                    {initialsOf('', other.email)}
                  </AvatarFallback>
                </Avatar>
              </ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle className="break-all">{other.email}</ItemTitle>
                <ItemDescription>Connected on this machine</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void linkAccount(other.sub)}
                >
                  Use in this vault
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setRemoving({ sub: other.sub, email: other.email })}
                >
                  Remove from Holi
                </Button>
              </ItemActions>
            </Item>
          ))}

          {/* Machine-wide: the client every account here was granted to. */}
          <OAuthClient
            accountCount={accounts.length}
            beforeChange={(change) => changeAccount(change, false)}
            disabled={busy}
            visible={visible}
          />
        </div>
      </FramePanel>

      <ConfirmDialog
        open={visible && removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null)
        }}
        title={
          <>
            Remove <span className="break-all">{removing?.email}</span> from Holi?
          </>
        }
        description="Holi revokes its access at Google. Every vault using this account stops reading mail and calendar."
        confirmLabel="Remove account"
        destructive
        // Stays open until Google has answered.
        onConfirm={() => (removing === null ? undefined : removeAccount(removing.sub))}
      />
    </Frame>
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
    <Item variant="muted">
      <ItemMedia variant="icon">
        <ImageIcon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>Images from trusted senders</ItemTitle>
        <ItemDescription>
          Images load automatically from {senders.size} {senders.size === 1 ? 'sender' : 'senders'}.
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button variant="outline" size="sm" onClick={() => void forget()}>
          Forget them
        </Button>
      </ItemActions>
    </Item>
  )
}
