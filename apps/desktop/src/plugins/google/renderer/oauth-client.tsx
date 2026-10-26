/**
 * The OAuth client this machine connects with (docs/features/google.md):
 * Holi's, which takes syv.ai accounts only, or one the person brings for any
 * other account. A row in Connections names it, and its button opens the form.
 *
 * **Machine-wide, unlike the rest of the section**, because the accounts it
 * connects are. A grant belongs to the client that made it, so saving a
 * different client disconnects every account here: the button names the
 * cost, and with accounts at stake it asks once more before it acts. The
 * same id with a new secret is the same client and costs nothing. The secret
 * goes to main and never comes back.
 */
import { useAtomValue } from 'jotai'
import { ExternalLinkIcon, KeyRoundIcon, TriangleAlertIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { activeRemoteAtom, openExternal } from '@/plugin-api'
import { googleCap } from './google-cap'

type ClientInfo = Awaited<ReturnType<typeof googleCap.client>>

/** Where Google's Desktop app clients are made. */
const CREDENTIALS_URL = 'https://console.cloud.google.com/apis/credentials'

/** Who the client in use is, in a sentence. */
function clientLabel(client: ClientInfo): string {
  if (client.source === 'own') return `Your own client, ${client.id}.`
  if (client.source === 'environment') return 'The client in HOLI_GOOGLE_CLIENT_ID.'
  return 'Holi’s client, which accepts syv.ai accounts only.'
}

export function OAuthClient({
  accountCount,
  onChanged,
}: {
  /** The accounts connected on this machine: what a new client disconnects. */
  accountCount: number
  onChanged: () => void
}): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const [client, setClient] = useState<ClientInfo | null>(null)
  const [failed, setFailed] = useState(false)
  const [version, setVersion] = useState(0)
  const [open, setOpen] = useState(false)
  const [id, setId] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** The change that would disconnect accounts, asked about once more. */
  const [asking, setAsking] = useState<{ id: string; secret: string } | null>(null)

  useEffect(() => {
    if (remote === null) return
    let live = true
    setFailed(false)
    googleCap.client(remote).then(
      (next) => live && setClient(next),
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [remote, version])

  const close = () => {
    setOpen(false)
    setId('')
    setSecret('')
    setError(null)
    setAsking(null)
  }

  const save = async (next: { id: string; secret: string }) => {
    if (remote === null) return
    setBusy(true)
    try {
      await googleCap.setClient(remote, next)
      close()
      setVersion((v) => v + 1)
      onChanged()
    } catch (err) {
      setAsking(null)
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
  const sameClient = client !== null && id.trim() === client.id
  const saveCost = sameClient ? '' : cost
  const canSave = !busy && id.trim() !== '' && secret.trim() !== ''

  /** Act now, or ask first when it disconnects accounts. */
  const attempt = (next: { id: string; secret: string }, costs: boolean) => {
    if (costs) setAsking(next)
    else void save(next)
  }

  return (
    <Item variant="muted" data-oauth-client>
      <ItemMedia variant="icon">
        <KeyRoundIcon />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle>OAuth client</ItemTitle>
        <ItemDescription className="break-words">
          {client !== null ? (
            clientLabel(client)
          ) : failed ? (
            'Holi could not say which client it uses.'
          ) : (
            <Skeleton className="h-4 w-48" />
          )}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        {failed ? (
          <Button variant="outline" size="sm" onClick={() => setVersion((v) => v + 1)}>
            Retry
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={client === null}
            onClick={() => setOpen(true)}
          >
            {client?.source === 'own' ? 'Change client…' : 'Use your own client…'}
          </Button>
        )}
      </ItemActions>

      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <DialogContent className="sm:max-w-lg">
          {/* Enter in a field saves, as a form would. */}
          <div
            className="flex flex-col gap-6"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
                event.preventDefault()
                if (canSave) attempt({ id, secret }, saveCost !== '')
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>Your own OAuth client</DialogTitle>
              <DialogDescription>
                For a Google account outside syv.ai: an OAuth client of type Desktop app, with the
                Gmail, Google Calendar and People APIs enabled. Kept on this machine only, and used
                by every vault here.
              </DialogDescription>
            </DialogHeader>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="self-start"
              onClick={() => openExternal(CREDENTIALS_URL)}
            >
              <ExternalLinkIcon data-icon="inline-start" aria-hidden="true" />
              Make one in Google Cloud
            </Button>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="google-client-id">Client ID</FieldLabel>
                <Input
                  id="google-client-id"
                  value={id}
                  placeholder="123-abc.apps.googleusercontent.com"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => setId(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="google-client-secret">Client secret</FieldLabel>
                <Input
                  id="google-client-secret"
                  type="password"
                  value={secret}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => setSecret(event.target.value)}
                />
              </Field>
              {error !== null ? <FieldError>{error}</FieldError> : null}
            </FieldGroup>
            {asking !== null ? (
              <Alert variant="destructive">
                <TriangleAlertIcon aria-hidden="true" />
                <AlertTitle>
                  This disconnects {accountCount} {accountCount === 1 ? 'account' : 'accounts'}
                </AlertTitle>
                <AlertDescription>
                  Their access was granted to the client Holi uses now. Every vault on this machine
                  stops reading mail and calendar until you connect again.
                </AlertDescription>
              </Alert>
            ) : null}
            <DialogFooter className="flex-wrap">
              {client?.source === 'own' && asking === null ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => attempt({ id: '', secret: '' }, cost !== '')}
                >
                  Use the default client{cost}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={asking !== null ? () => setAsking(null) : close}
              >
                {asking !== null ? 'Keep my accounts' : 'Cancel'}
              </Button>
              {asking !== null ? (
                <Button
                  type="button"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void save(asking)}
                >
                  Disconnect and switch
                </Button>
              ) : (
                <Button
                  type="button"
                  disabled={!canSave}
                  onClick={() => attempt({ id, secret }, saveCost !== '')}
                >
                  Save{saveCost}
                </Button>
              )}
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </Item>
  )
}
