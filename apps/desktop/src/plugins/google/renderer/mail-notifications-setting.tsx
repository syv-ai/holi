import { useEffect, useRef, useState } from 'react'
import { useAtomValue, useStore } from 'jotai'
import { MailIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item'
import { Switch } from '@/components/ui/switch'
import {
  activeRemoteAtom,
  activeRemoteRevisionValueAtom,
  activeVaultSettingsAtom,
  loadVaultSettingsAtom,
  trpc,
} from '@/plugin-api'
import { GOOGLE_INFO } from '../info'

/** The machine-local opt-in for native notices; sidebar attention is independent. */
export function MailNotificationsSetting(): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const remoteRevision = useAtomValue(activeRemoteRevisionValueAtom)
  const settings = useAtomValue(activeVaultSettingsAtom)
  const store = useStore()
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState<boolean | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    generation.current += 1
    setOptimistic(null)
    setPending(false)
    setError(null)
    setRetry(null)
  }, [remote, remoteRevision])

  const saved = settings?.pluginValues[GOOGLE_INFO.id]?.mailNotifications === true
  const checked = optimistic ?? saved
  const current = (attempt: number, origin: string, revision: number) =>
    generation.current === attempt &&
    store.get(activeRemoteAtom) === origin &&
    store.get(activeRemoteRevisionValueAtom) === revision

  const save = async (enabled: boolean) => {
    if (remote === null || pending) return
    const origin = remote
    const revision = remoteRevision
    const attempt = generation.current
    setOptimistic(enabled)
    setPending(true)
    setError(null)
    setRetry(enabled)
    try {
      const patch = JSON.stringify({ [GOOGLE_INFO.id]: { mailNotifications: enabled } })
      const result = await trpc.settings.write.mutate({ remote: origin, localJson: patch })
      if (result.warnings.length > 0) throw new Error(result.warnings.join(' '))
      if (!current(attempt, origin, revision)) return
      await store.set(loadVaultSettingsAtom, {
        force: true,
        invalidatePluginValues: { plugin: GOOGLE_INFO.id, keys: ['mailNotifications'] },
      })
      if (!current(attempt, origin, revision)) return
      setOptimistic(null)
      setRetry(null)
    } catch (cause) {
      if (!current(attempt, origin, revision)) return
      setError(
        cause instanceof Error
          ? `Could not save desktop mail notifications. ${cause.message}`
          : 'Could not save desktop mail notifications.',
      )
    } finally {
      if (current(attempt, origin, revision)) setPending(false)
    }
  }

  const retryRead = async () => {
    if (remote === null || pending) return
    const origin = remote
    const revision = remoteRevision
    const attempt = generation.current
    setPending(true)
    setError(null)
    try {
      await store.set(loadVaultSettingsAtom, { force: true })
    } catch (cause) {
      if (!current(attempt, origin, revision)) return
      setError(
        cause instanceof Error
          ? `Could not read desktop mail notifications. ${cause.message}`
          : 'Could not read desktop mail notifications.',
      )
    } finally {
      if (current(attempt, origin, revision)) setPending(false)
    }
  }

  return (
    <Item variant="muted">
      <ItemMedia variant="icon">
        <MailIcon aria-hidden="true" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>Desktop mail notifications</ItemTitle>
        <ItemDescription>
          Show a desktop notification when unread mail arrives for this vault. The sidebar unread
          count does not depend on this switch.
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Switch
          aria-label="Show desktop mail notifications"
          checked={checked}
          disabled={pending || settings === null}
          onCheckedChange={(enabled) => void save(enabled)}
        />
      </ItemActions>
      {settings === null && error === null && (
        <span role="status" className="flex items-center gap-2">
          Loading desktop mail notifications…
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label="Retry desktop mail notifications"
            disabled={pending}
            onClick={() => void retryRead()}
          >
            Retry
          </Button>
        </span>
      )}
      {error !== null && (
        <span role="alert" className="flex items-center gap-2 text-destructive">
          {error}
          <Button
            type="button"
            variant="text"
            size="sm"
            aria-label="Retry desktop mail notifications"
            disabled={pending}
            onClick={() => void (retry === null ? retryRead() : save(retry))}
          >
            Retry
          </Button>
        </span>
      )}
      {pending && settings !== null && error === null && (
        <span role="status" className="text-muted-foreground">
          Saving…
        </span>
      )}
    </Item>
  )
}
