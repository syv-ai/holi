/**
 * The Mødelokale Booking section of the settings tab: who this machine is signed in
 * to the booking site as, and signing in or out (docs/features/booking.md).
 *
 * The sign-in is the machine's, kept encrypted by main and refreshed there,
 * so it holds across restarts and vault switches; this section only shows it.
 * Nothing here sees a token: main answers with an email address.
 *
 * Signing in is the same `booking.login` the app and the agent use: main
 * emails a login link and watches Gmail for it. When Gmail cannot deliver it,
 * the section asks for the link from the email instead.
 */
import { ShieldCheckIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Frame, FramePanel } from '@/components/ui/frame'
import { IconTile } from '@/components/ui/icon-tile'
import { Input } from '@/components/ui/input'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item'
import { pluginMark } from '@/composites/marks'
import { capClient, type UiCapability } from '@/plugin-api'
import type { BookingCapabilities } from '../main/capabilities'

const booking = capClient<BookingCapabilities>('booking')
/** Google's one verb this reads, typed as a slice: plugins never import each
 *  other. Used only to offer the connected address as the default. */
const google = capClient<{
  'google.status': UiCapability<void, { account: { email: string } | null }>
}>('google')

type Status = Awaited<ReturnType<typeof booking.status>>

type Phase =
  | { kind: 'idle'; error?: string }
  | { kind: 'sending' }
  | { kind: 'paste'; note: string; error?: string }
  | { kind: 'finishing' }

const message = (err: unknown): string =>
  err instanceof Error ? err.message : 'The booking site did not answer.'

export function BookingSection({ remote }: { remote: string }): React.JSX.Element {
  const [status, setStatus] = useState<Status | undefined>(undefined)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [email, setEmail] = useState('')
  const [link, setLink] = useState('')
  /** Why main's answer could not be read, until a Retry reads it. */
  const [loadError, setLoadError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await booking.status(remote))
    } catch (err) {
      setLoadError(message(err))
    }
  }, [remote])

  const retry = () => {
    setLoadError(null)
    void refresh()
  }

  useEffect(() => {
    void refresh()
    // The Google address is only a default; no Google is no default.
    google
      .status(remote)
      .then((s) => setEmail((current) => current || s.account?.email || ''))
      .catch(() => undefined)
  }, [refresh, remote])

  const signIn = async () => {
    const address = email.trim()
    if (address === '') return
    setPhase({ kind: 'sending' })
    try {
      const result = await booking.login(remote, { email: address })
      if (result.signedIn) {
        setStatus(result)
        setPhase({ kind: 'idle' })
      } else {
        setPhase({ kind: 'paste', note: result.message ?? 'Check your email for the login link.' })
      }
    } catch (err) {
      setPhase({ kind: 'idle', error: message(err) })
    }
  }

  const finish = async () => {
    // Enter in the field while a link is being used would spend it twice.
    if (link.trim() === '' || phase.kind === 'finishing') return
    setPhase({ kind: 'finishing' })
    try {
      setStatus(await booking.finish(remote, { link: link.trim() }))
      setLink('')
      setPhase({ kind: 'idle' })
    } catch (err) {
      setPhase({ kind: 'paste', note: 'Paste the link from the login email.', error: message(err) })
    }
  }

  const signOut = async () => {
    try {
      setStatus(await booking.logout(remote))
      setPhase({ kind: 'idle' })
    } catch (err) {
      setPhase({ kind: 'idle', error: message(err) })
    }
  }

  const onEnter = (fn: () => void) => (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') fn()
  }

  const site = status?.site ?? 'the booking site'
  const signedIn = status?.signedIn === true
  const sending = phase.kind === 'sending'
  const error = loadError ?? ((phase.kind === 'idle' || phase.kind === 'paste') && phase.error)

  return (
    <Frame>
      <FramePanel>
        <div className="flex flex-col gap-2.5">
          <Item>
            <ItemMedia className="translate-y-0! self-center!">
              <IconTile>{pluginMark('booking')}</IconTile>
            </ItemMedia>
            <ItemContent className="min-w-0">
              <ItemTitle>Mødelokale Booking</ItemTitle>
              <ItemDescription className="break-words">
                {status === undefined ? (
                  loadError === null ? (
                    'Checking…'
                  ) : (
                    'Could not read this machine’s sign-in.'
                  )
                ) : signedIn ? (
                  <>
                    Signed in to {site} as <span className="text-foreground">{status.email}</span>
                  </>
                ) : sending ? (
                  'Sending the login email, then watching Gmail for it…'
                ) : (
                  `Sign in to ${site} to book rooms from the Booking app and the agent.`
                )}
              </ItemDescription>
              {error && (
                <p role="alert" className="text-sm text-pretty text-destructive">
                  {error}
                </p>
              )}
            </ItemContent>
            {signedIn && (
              <ItemActions>
                <Button variant="outline" size="sm" onClick={() => void signOut()}>
                  Sign out
                </Button>
              </ItemActions>
            )}
            {status === undefined && loadError !== null && (
              <ItemActions>
                <Button variant="outline" size="sm" onClick={retry}>
                  Retry
                </Button>
              </ItemActions>
            )}
          </Item>

          {signedIn ? (
            <Item variant="muted">
              <ItemMedia variant="icon">
                <ShieldCheckIcon />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Kept on this machine</ItemTitle>
                <ItemDescription>
                  The sign-in is stored encrypted and renewed by itself, so the Booking app and the
                  agent stay signed in across restarts and vaults.
                </ItemDescription>
              </ItemContent>
            </Item>
          ) : (
            status !== undefined && (
              <>
                <div className="flex items-center gap-2">
                  <Input
                    aria-label="Email"
                    type="email"
                    placeholder="you@company.com"
                    value={email}
                    disabled={sending}
                    onChange={(event) => setEmail(event.target.value)}
                    onKeyDown={onEnter(() => void signIn())}
                  />
                  <Button
                    size="sm"
                    className="shrink-0"
                    disabled={sending || email.trim() === ''}
                    onClick={() => void signIn()}
                  >
                    {sending ? 'Waiting for the email…' : 'Send login link'}
                  </Button>
                </div>
                {(phase.kind === 'paste' || phase.kind === 'finishing') && (
                  <>
                    {phase.kind === 'paste' && (
                      <p className="text-sm text-muted-foreground">{phase.note}</p>
                    )}
                    <div className="flex items-center gap-2">
                      <Input
                        aria-label="Login link"
                        placeholder="Paste the link from the email"
                        value={link}
                        disabled={phase.kind === 'finishing'}
                        onChange={(event) => setLink(event.target.value)}
                        onKeyDown={onEnter(() => void finish())}
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        disabled={phase.kind === 'finishing' || link.trim() === ''}
                        onClick={() => void finish()}
                      >
                        Sign in
                      </Button>
                    </div>
                  </>
                )}
              </>
            )
          )}
        </div>
      </FramePanel>
    </Frame>
  )
}
