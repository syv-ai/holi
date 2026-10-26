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
import { Alert, AlertDescription, AlertTitle } from '@/components/reui/alert'
import { Frame, FramePanel } from '@/components/reui/frame'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
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
import { IconTile, pluginMark } from '@/composites'
import { activeRemoteAtom } from '@/plugin-api'
import { googleCap, useGoogleAccount } from './account'
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
  /** The account a "Remove from Holi" is asking about, and whether the
   *  removal is in flight: it revokes at Google, so it is confirmed first. */
  const [removing, setRemoving] = useState<{ sub: string; email: string } | null>(null)
  const [removePending, setRemovePending] = useState(false)

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

  /**
   * Revoke at Google and drop it everywhere. The destructive one, and the only
   * one confirmed: unlinking this vault (Disconnect) is undone by "Use in this
   * vault", but a revoke takes mail and calendar from every vault using the
   * account and needs a fresh consent to get back.
   */
  const removeAccount = async (sub: string) => {
    setRemovePending(true)
    try {
      if (remote !== null) await googleCap.removeAccount(remote, { sub }).catch(() => undefined)
      refreshGoogle()
    } finally {
      setRemovePending(false)
      setRemoving(null)
    }
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
    <Frame>
      <FramePanel className="space-y-2.5">
        <Item className="p-0">
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
                  onClick={() => void disconnect()}
                >
                  Disconnect
                </Button>
              </>
            ) : (
              <Button size="sm" disabled={busy} onClick={() => void connect()}>
                {phase.kind === 'connecting' ? 'Connecting…' : connectLabel}
              </Button>
            )}
          </ItemActions>
        </Item>

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
              <Avatar className="size-8">
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
              <Button size="sm" variant="outline" onClick={() => void linkAccount(other.sub)}>
                Use in this vault
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setRemoving({ sub: other.sub, email: other.email })}
              >
                Remove from Holi
              </Button>
            </ItemActions>
          </Item>
        ))}

        {/* Machine-wide: the client every account here was granted to. */}
        <OAuthClient accountCount={accounts.length} onChanged={refreshGoogle} />
      </FramePanel>

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !removePending) setRemoving(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove <span className="break-all">{removing?.email}</span> from Holi?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Holi revokes its access at Google. Every vault using this account stops reading mail
              and calendar.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removePending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={removePending}
              onClick={(event) => {
                // Stays open until Google has answered.
                event.preventDefault()
                if (removing !== null) void removeAccount(removing.sub)
              }}
            >
              {removePending ? 'Removing…' : 'Remove account'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
