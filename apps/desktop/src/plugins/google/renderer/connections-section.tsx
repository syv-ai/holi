/**
 * The Connections section of the settings tab: the Google account behind mail
 * and calendar. The plugin contributes it as a settings section.
 *
 * Connections and account actions are scoped to the open vault. Connecting
 * always requests consent; this section never lists accounts from other vaults.
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
 * inside the same frame. Last, the OAuth client this vault uses for future
 * connections (`OAuthClient`), Holi's or the person's own.
 */
import { useAtomValue } from 'jotai'
import { ImageIcon, ShieldCheckIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Frame, FramePanel } from '@/components/ui/frame'
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
import {
  activeRemoteAtom,
  activeVaultSettingsAtom,
  loadVaultSettingsAtom,
  withSavedBuffers,
} from '@/plugin-api'
import { useSetAtom } from 'jotai'
import { googleCap } from './google-cap'
import { useGoogleAccount } from './account'
import { OAuthClient } from './oauth-client'
import {
  useAlwaysAllowedSenders,
  useForgetImageSenders,
  useMailImagePolicyPending,
  useSetAllSenderImages,
} from './mail-images'
import { Switch } from '@/components/ui/switch'
import { MailMarkersSettings } from './mail-markers-settings'
import { MailNotificationsSetting } from './mail-notifications-setting'

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
  useEffect(() => {
    if (!visible) {
      invalidateGeneration()
      const remote = connecting.current
      connecting.current = null
      if (remote !== null) void googleCap.cancelConnect(remote)
      setPhase({ kind: 'idle' })
    }
    setPhase({ kind: 'idle' })
    setChangingAccount(false)
    setLifecycleError(null)
    return () => {
      invalidateGeneration()
      const remote = connecting.current
      connecting.current = null
      if (remote !== null) void googleCap.cancelConnect(remote)
    }
  }, [visible, remote, currentSub])

  const connect = async () => {
    if (remote === null) return
    const attempt = ++generation.current
    const ownsAttempt = () => generation.current === attempt
    setPhase({ kind: 'connecting' })
    connecting.current = remote
    try {
      await withSavedBuffers(async () => {
        if (ownsAttempt()) await googleCap.connect(remote)
      })
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
    const owner = generation.current
    const ownsChange = () => generation.current === owner
    setChangingAccount(true)
    setLifecycleError(null)
    let mutationStarted = false
    try {
      await withSavedBuffers(async () => {
        if (!ownsChange()) return
        mutationStarted = true
        await change()
        if (ownsChange()) await refreshAndWait()
      })
      return null
    } catch (err) {
      const detail = err instanceof Error ? ` ${err.message}` : ''
      const message = mutationStarted
        ? `Could not confirm the Google account change.${detail} Check the connection before retrying.`
        : `Could not save your mail draft, so the Google account was not changed.${detail} The current account remains connected. Save or copy the draft, then retry.`
      if (showLifecycleError && ownsChange()) setLifecycleError(message)
      return message
    } finally {
      if (ownsChange()) setChangingAccount(false)
    }
  }

  /** Unlink THIS vault. The account and every other vault using it survive. */
  const disconnect = async () => {
    if (remote === null) return
    await changeAccount(() => googleCap.disconnectVault(remote))
  }

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
                  'Google stopped accepting this connection. Connect again to this vault.'
                ) : loading ? (
                  'Checking your Google connection…'
                ) : (
                  'Read and triage your Gmail, read your Calendar. This vault only.'
                )}
              </ItemDescription>
              {phase.kind === 'idle' && phase.error !== undefined && (
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
                    {phase.kind === 'connecting' ? 'Connecting…' : 'Connect'}
                  </Button>
                  {needsReconnect && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void disconnect()}
                    >
                      Forget this vault's connection
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
          {connected && <MailNotificationsSetting />}
          {connected && <ImageSenders />}
          {connected && remote !== null && currentSub !== null && (
            <MailMarkersSettings
              key={`${remote}:${currentSub}`}
              vault={remote}
              accountSub={currentSub}
            />
          )}

          {/* This vault’s future-consent client; existing grants keep their issuer. */}
          <OAuthClient
            key={remote}
            beforeChange={(change) => changeAccount(change, false)}
            disabled={busy}
            visible={visible}
          />
        </div>
      </FramePanel>
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
function ImageSenders(): React.JSX.Element {
  const policy = useAlwaysAllowedSenders()
  const settings = useAtomValue(activeVaultSettingsAtom)
  const reload = useSetAtom(loadVaultSettingsAtom)
  const forget = useForgetImageSenders()
  const setAll = useSetAllSenderImages()
  const sharedPending = useMailImagePolicyPending()
  const [pending, setPending] = useState(false)
  const busy = pending || sharedPending
  const [error, setError] = useState<string | null>(null)
  const [retryAction, setRetryAction] = useState<(() => Promise<void>) | null>(null)
  const run = async (action: () => Promise<void>) => {
    setRetryAction(() => action)
    setPending(true)
    setError(null)
    try {
      await action()
      setRetryAction(null)
    } catch {
      setError('Could not save or read the remote image setting.')
    } finally {
      setPending(false)
    }
  }
  const retryRead = async () => {
    setPending(true)
    setError(null)
    try {
      await reload({ force: true })
    } catch {
      setError('Could not read remote image settings.')
    } finally {
      setPending(false)
    }
  }

  return (
    <Item variant="muted">
      <ItemMedia variant="icon">
        <ImageIcon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>Remote images</ItemTitle>
        <ItemDescription>
          Loading remote images can tell senders when you open mail.{' '}
          {policy.allSenders
            ? 'Images from all senders load automatically.'
            : `Images from ${policy.senders.size} trusted ${policy.senders.size === 1 ? 'sender' : 'senders'} load automatically; others stay blocked.`}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Switch
          aria-label="Always load images from all senders"
          checked={policy.allSenders}
          onCheckedChange={(enabled) => void run(() => setAll(enabled))}
          disabled={busy || settings === null}
        />
        {policy.senders.size > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void run(forget)}
            disabled={busy || settings === null}
          >
            Forget senders
          </Button>
        )}
      </ItemActions>
      {settings === null && error === null && (
        <span role="status" className="flex items-center gap-2">
          Loading remote image settings…
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => void retryRead()}
            disabled={pending}
          >
            Retry
          </Button>
        </span>
      )}
      {error !== null && (
        <span role="status" className="flex items-center gap-2">
          {error}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => void (retryAction ? run(retryAction) : retryRead())}
            disabled={pending}
          >
            Retry
          </Button>
        </span>
      )}
    </Item>
  )
}
