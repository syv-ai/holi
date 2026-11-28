import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  MAIL_MARKERS,
  normalizeMailMarkerPreferences,
  type MailMarker,
  type MailMarkerPreferences,
} from '../shared/mail-markers'
import { googleCap } from './google-cap'
import { publishMailMarkerPreferences } from './use-mail-marker-actions'

const LABELS: Record<MailMarker, string> = {
  'yellow-star': 'Yellow star',
  'red-star': 'Red star',
  'blue-question': 'Blue question mark',
}

type LoadState = 'loading' | 'ready' | 'error'

/** Per-account, machine-local personal marker preferences for Google Mail. */
export function MailMarkersSettings({
  vault,
  accountSub,
}: {
  vault: string
  accountSub: string
}): React.JSX.Element {
  const identity = `${vault}\u0000${accountSub}`
  const generation = useRef(0)
  const currentIdentity = useRef(identity)
  if (currentIdentity.current !== identity) {
    currentIdentity.current = identity
    generation.current += 1
  }
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [preferences, setPreferences] = useState<MailMarkerPreferences | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const savedRetry = useRef<MailMarkerPreferences | null>(null)

  const owns = (attempt: number) =>
    currentIdentity.current === identity && generation.current === attempt

  const load = async () => {
    const attempt = ++generation.current
    setLoadState('loading')
    setPreferences(null)
    setPending(false)
    savedRetry.current = null
    setError(null)
    try {
      const value = await googleCap.mailMarkerPreferences(vault, { expectedAccountSub: accountSub })
      if (!owns(attempt)) return
      setPreferences(normalizeMailMarkerPreferences(value))
      setLoadState('ready')
    } catch (cause) {
      if (!owns(attempt)) return
      setLoadState('error')
      setError(cause instanceof Error ? cause.message : 'Could not load marker preferences.')
    }
  }

  useEffect(() => {
    void load()
    return () => {
      generation.current += 1
    }
    // The component is keyed by vault and account by its owner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault, accountSub])

  const save = async (next: MailMarkerPreferences, retry = false) => {
    if (pending) return
    const attempt = generation.current
    setPending(true)
    setError(null)
    savedRetry.current = retry ? next : null
    try {
      await googleCap.setMailMarkerPreferences(vault, {
        expectedAccountSub: accountSub,
        preferences: next,
      })
      if (!owns(attempt)) return
      const normalized = normalizeMailMarkerPreferences(next)
      setPreferences(normalized)
      publishMailMarkerPreferences(vault, accountSub, normalized)
      savedRetry.current = null
    } catch (cause) {
      if (!owns(attempt)) return
      savedRetry.current = next
      setError(cause instanceof Error ? cause.message : 'Could not save marker preferences.')
    } finally {
      if (owns(attempt)) setPending(false)
    }
  }

  const update = (next: MailMarkerPreferences) => {
    if (pending || preferences === null) return
    const normalized = normalizeMailMarkerPreferences(next)
    setPreferences(normalized)
    void save(normalized)
  }

  const toggle = (marker: MailMarker, enabled: boolean) => {
    const order = preferences?.enabledOrder ?? []
    update({ enabledOrder: enabled ? [...order, marker] : order.filter((item) => item !== marker) })
  }

  const move = (marker: MailMarker, direction: -1 | 1) => {
    const order = preferences?.enabledOrder ?? []
    const index = order.indexOf(marker)
    const target = index + direction
    if (index < 0 || target < 0 || target >= order.length) return
    const next = [...order]
    const markerAtIndex = next[index]
    const markerAtTarget = next[target]
    if (markerAtIndex === undefined || markerAtTarget === undefined) return
    next[index] = markerAtTarget
    next[target] = markerAtIndex
    update({ enabledOrder: next })
  }

  return (
    <section aria-labelledby="mail-markers-heading" className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h3 id="mail-markers-heading" className="text-sm font-medium">
          Personal markers
        </h3>
        <p className="text-sm text-muted-foreground">
          These settings are for this vault’s Google connection on this machine. Turning a marker
          off does not remove it from existing mail annotations.
        </p>
      </div>
      {loadState === 'loading' ? (
        <div aria-label="Loading personal markers" role="status" className="flex flex-col gap-2">
          {MAIL_MARKERS.map((marker) => (
            <Skeleton key={marker} className="h-10 w-full" />
          ))}
        </div>
      ) : loadState === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          Could not load personal markers. {error}{' '}
          <Button type="button" size="sm" variant="text" onClick={() => void load()}>
            Retry
          </Button>
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {MAIL_MARKERS.map((marker) => {
            const index = preferences?.enabledOrder.indexOf(marker) ?? -1
            const enabled = index >= 0
            return (
              <Item key={marker}>
                <ItemContent>
                  <ItemTitle>{LABELS[marker]}</ItemTitle>
                  {enabled && <ItemDescription>Position {index + 1}</ItemDescription>}
                </ItemContent>
                <ItemActions>
                  {enabled && (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-label={`Move ${LABELS[marker]} up`}
                        disabled={pending || index === 0}
                        onClick={() => move(marker, -1)}
                      >
                        Move up
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-label={`Move ${LABELS[marker]} down`}
                        disabled={pending || index === (preferences?.enabledOrder.length ?? 0) - 1}
                        onClick={() => move(marker, 1)}
                      >
                        Move down
                      </Button>
                    </>
                  )}
                  <Switch
                    aria-label={`Enable ${LABELS[marker]}`}
                    checked={enabled}
                    disabled={pending}
                    onCheckedChange={(checked) => toggle(marker, checked)}
                  />
                </ItemActions>
              </Item>
            )
          })}
          {error !== null && (
            <p role="alert" className="text-sm text-destructive">
              Could not save personal markers. {error}{' '}
              <Button
                type="button"
                size="sm"
                variant="text"
                disabled={pending}
                onClick={() => {
                  const retry = savedRetry.current
                  if (retry !== null) void save(retry, true)
                }}
              >
                Retry
              </Button>
            </p>
          )}
          {pending ? (
            <p role="status" className="text-sm text-muted-foreground">
              Saving…
            </p>
          ) : error === null ? (
            <p role="status" className="text-sm text-muted-foreground">
              Saved on this machine.
            </p>
          ) : null}
        </div>
      )}
    </section>
  )
}
