import { useCallback, useEffect, useRef, useState } from 'react'
import type { MailMarker, MailMarkerPreferences } from '../shared/mail-markers'
import { DEFAULT_MAIL_MARKER_PREFERENCES } from '../shared/mail-markers'
import { googleCap } from './google-cap'
import { MailMarkerActions, type MailMarkerState } from './mail-marker-actions'

type Overlay = Record<string, MailMarkerState & { error: boolean }>
type PreferenceEvent = CustomEvent<{
  vault: string
  accountSub: string
  preferences: MailMarkerPreferences
}>
const PREFERENCES_EVENT = 'holi:mail-marker-preferences-changed'
const SETTLED_OVERLAY_MS = 1_000

/** Shared primary-marker interaction for both Gmail list/reader implementations. */
export function useMailMarkerActions({
  remote,
  accountSub,
  activeThreadId,
  reconcile,
  onFailure,
  onChange,
}: {
  remote: string | null
  accountSub: string | null
  activeThreadId: string | null
  reconcile: (id: string) => void
  onFailure: (cause: unknown) => void
  onChange: (id: string, state: MailMarkerState) => void
}) {
  const [overlay, setOverlay] = useState<Overlay>({})
  const preferencesRef = useRef<MailMarkerPreferences>(DEFAULT_MAIL_MARKER_PREFERENCES)
  const ownerRef = useRef('')
  const lifecycleRef = useRef(0)
  const settlementTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const callbacks = useRef({ reconcile, onFailure, onChange })
  callbacks.current = { reconcile, onFailure, onChange }
  const controller = useRef<MailMarkerActions | null>(null)
  if (controller.current === null) {
    controller.current = new MailMarkerActions({
      write: async (owner, id, marker) => {
        const [capturedRemote, capturedSub] = owner.split('\u0000')
        if (!capturedRemote || !capturedSub) throw new Error('Mail owner changed')
        await googleCap.setMailMarker(capturedRemote, {
          id,
          marker,
          expectedAccountSub: capturedSub,
        })
      },
      reconcile: async (owner, id, readActualStar) => {
        const lifecycle = lifecycleRef.current
        const [capturedRemote, capturedSub] = owner.split('\u0000')
        if (!capturedRemote || !capturedSub) throw new Error('Mail owner changed')
        const result = await googleCap.mailMarkerAnnotations(capturedRemote, {
          ids: [id],
          expectedAccountSub: capturedSub,
        })
        const marker = result[id] ?? null
        const starred = readActualStar
          ? await readGmailStarred(capturedRemote, id)
          : marker !== null
        if (lifecycleRef.current === lifecycle && ownerRef.current === owner)
          callbacks.current.reconcile(id)
        return { marker, starred }
      },
      changed: (id, state, error) => {
        const timer = settlementTimers.current.get(id)
        if (timer !== undefined) clearTimeout(timer)
        settlementTimers.current.delete(id)
        callbacks.current.onChange(id, state)
        setOverlay((current) => ({ ...current, [id]: { ...state, error } }))
      },
      settled: (id) => {
        const owner = ownerRef.current
        const lifecycle = lifecycleRef.current
        const timer = setTimeout(() => {
          settlementTimers.current.delete(id)
          if (ownerRef.current !== owner || lifecycleRef.current !== lifecycle) return
          setOverlay((current) => {
            if (!(id in current)) return current
            const next = { ...current }
            delete next[id]
            return next
          })
        }, SETTLED_OVERLAY_MS)
        settlementTimers.current.set(id, timer)
      },
      failed: (cause) => callbacks.current.onFailure(cause),
    })
  }
  const actions = controller.current
  const owner = `${remote ?? ''}\u0000${accountSub ?? ''}`
  ownerRef.current = owner

  useEffect(() => {
    actions.resetBurst()
  }, [actions, activeThreadId])

  useEffect(() => {
    setOverlay({})
    preferencesRef.current = DEFAULT_MAIL_MARKER_PREFERENCES
    actions.setOwner(owner, DEFAULT_MAIL_MARKER_PREFERENCES.enabledOrder)
    if (remote === null || accountSub === null) return
    let active = true
    const effectGeneration = lifecycleRef.current + 1
    lifecycleRef.current = effectGeneration
    const timers = settlementTimers.current
    let preferenceRevision = 0
    const onPreferences = (event: Event) => {
      const detail = (event as PreferenceEvent).detail
      if (detail.accountSub !== accountSub) return
      preferenceRevision++
      preferencesRef.current = detail.preferences
      actions.setOwner(owner, detail.preferences.enabledOrder)
    }
    window.addEventListener(PREFERENCES_EVENT, onPreferences)
    const revisionAtLoad = preferenceRevision
    void googleCap
      .mailMarkerPreferences(remote, { expectedAccountSub: accountSub })
      .then((loaded) => {
        if (!active || preferenceRevision !== revisionAtLoad) return
        preferencesRef.current = loaded
        actions.setOwner(owner, loaded.enabledOrder)
      })
      .catch(() => undefined)
    return () => {
      active = false
      lifecycleRef.current = effectGeneration + 1
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      window.removeEventListener(PREFERENCES_EVENT, onPreferences)
      actions.dispose()
    }
  }, [actions, owner, remote, accountSub])

  const activate = useCallback(
    (id: string, starred: boolean, marker: MailMarker | null) => {
      if (remote === null || accountSub === null) return
      const current = overlay[id]
      actions.activate(
        id,
        current?.starred ?? starred,
        current === undefined ? marker : current.marker,
      )
    },
    [actions, remote, accountSub, overlay],
  )
  const get = useCallback((id: string) => overlay[id], [overlay])
  const retry = useCallback(
    (id: string) => {
      if (overlay[id]?.error) return actions.retry(id)
      actions.invalidate(id)
      return Promise.resolve()
    },
    [actions, overlay],
  )
  const invalidate = useCallback(
    (id: string) => {
      const timer = settlementTimers.current.get(id)
      if (timer !== undefined) clearTimeout(timer)
      settlementTimers.current.delete(id)
      actions.invalidate(id)
      setOverlay((current) => {
        if (!(id in current)) return current
        const next = { ...current }
        delete next[id]
        return next
      })
    },
    [actions],
  )
  return { activate, get, retry, invalidate }
}

async function readGmailStarred(remote: string, id: string): Promise<boolean> {
  let pageToken: string | undefined
  do {
    const page = await googleCap.search(remote, {
      query: 'is:starred',
      ...(pageToken === undefined ? {} : { pageToken }),
    })
    if (page.threads.some((thread) => thread.id === id)) return true
    if (page.unreadableThreadIds?.includes(id))
      throw new Error('Gmail could not verify whether this thread is starred.')
    pageToken = page.nextPageToken ?? undefined
  } while (pageToken !== undefined)
  return false
}

export function publishMailMarkerPreferences(
  vault: string,
  accountSub: string,
  preferences: MailMarkerPreferences,
): void {
  window.dispatchEvent(
    new CustomEvent<PreferenceEvent['detail']>(PREFERENCES_EVENT, {
      detail: { vault, accountSub, preferences },
    }),
  )
}
