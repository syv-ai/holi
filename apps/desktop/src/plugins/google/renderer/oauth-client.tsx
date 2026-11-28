/**
 * The OAuth client this machine connects with (docs/features/google.md):
 * Holi's, which takes syv.ai accounts only, or one the person brings for any
 * other account. A row in Connections names it, and its button opens the form.
 *
 * The machine-wide default governs new connections. Existing grants keep
 * their issuing client; the secret goes to main and never comes back.
 */
import { useAtomValue } from 'jotai'
import { ExternalLinkIcon, KeyRoundIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
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
  beforeChange,
  disabled = false,
  visible = true,
}: {
  beforeChange: (change: () => Promise<void>) => Promise<string | null>
  disabled?: boolean
  visible?: boolean
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

  useEffect(() => {
    if (remote === null || !visible) return
    let live = true
    setFailed(false)
    googleCap.client(remote).then(
      (next) => live && setClient(next),
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [remote, version, visible])

  useEffect(() => {
    if (!visible) {
      setOpen(false)
    }
  }, [visible])

  const close = () => {
    setOpen(false)
    setId('')
    setSecret('')
    setError(null)
  }

  const save = async (next: { id: string; secret: string }) => {
    if (remote === null) return
    setBusy(true)
    try {
      const error = await beforeChange(async () => {
        await googleCap.setClient(remote, next)
      })
      if (error !== null) {
        setError(error)
        return
      }
      close()
      setVersion((v) => v + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the client.')
    } finally {
      setBusy(false)
    }
  }

  const canSave = !busy && id.trim() !== '' && secret.trim() !== ''

  return (
    <Item variant="muted" data-oauth-client>
      <ItemMedia variant="icon">
        <KeyRoundIcon />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle>OAuth client for new connections</ItemTitle>
        <ItemDescription className="break-words">
          {client !== null ? (
            clientLabel(client)
          ) : failed ? (
            'Could not read the client for new connections.'
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
            disabled={client === null || disabled}
            onClick={() => setOpen(true)}
          >
            {client?.source === 'own' ? 'Change client…' : 'Use your own client…'}
          </Button>
        )}
      </ItemActions>

      <Dialog open={visible && open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <DialogContent className="sm:max-w-lg">
          {/* Enter in a field saves, as a form would. */}
          <div
            className="flex flex-col gap-6"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
                event.preventDefault()
                if (canSave) void save({ id, secret })
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>Your own OAuth client</DialogTitle>
              <DialogDescription>
                For a Google account outside syv.ai: an OAuth client of type Desktop app, with the
                Gmail, Google Calendar and People APIs enabled. Kept on this machine only, and used
                for new connections in every vault here. Existing accounts stay connected with their
                original client.
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
            <DialogFooter className="flex-wrap">
              {client?.source === 'own' ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void save({ id: '', secret: '' })}
                >
                  Use the default client
                </Button>
              ) : null}
              <Button type="button" variant="outline" disabled={busy} onClick={close}>
                Cancel
              </Button>
              <Button type="button" disabled={!canSave} onClick={() => void save({ id, secret })}>
                Save
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </Item>
  )
}
