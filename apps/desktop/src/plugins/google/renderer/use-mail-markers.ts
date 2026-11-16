import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MarkerValue } from '../shared/mail-markers'
import { isMailMarker } from '../shared/mail-markers'
import { googleCap } from './google-cap'

export type MailMarkerStatus =
  { kind: 'loading' } | { kind: 'ready'; marker: MarkerValue } | { kind: 'error' }

type StateMap = Record<string, MailMarkerStatus>

const BATCH_SIZE = 100

/** Loads display annotations in bounded, account-owned batches for a mail surface. */
export function useMailMarkers({
  remote,
  accountSub,
  ids,
}: {
  remote: string | null
  accountSub: string | null
  ids: readonly string[]
}) {
  const idsKey = [...new Set(ids)].filter(Boolean).sort().join('\u0000')
  const uniqueIds = useMemo(() => (idsKey === '' ? [] : idsKey.split('\u0000')), [idsKey])
  const owner = `${remote ?? ''}\u0000${accountSub ?? ''}`
  const generation = useRef(0)
  const previousOwner = useRef(owner)
  if (previousOwner.current !== owner) {
    previousOwner.current = owner
    generation.current++
  }
  const [revision, setRevision] = useState(0)
  const requestSequence = useRef(0)
  const inFlight = useRef(new Map<string, number>())
  const [stored, setStored] = useState<{ generation: number; entries: StateMap }>({
    generation: generation.current,
    entries: {},
  })
  const requestGeneration = generation.current
  const entries = useMemo(
    () => (stored.generation === requestGeneration ? stored.entries : {}),
    [stored, requestGeneration],
  )

  const invalidate = useCallback(
    (targetIds?: readonly string[]) => {
      const targets = targetIds === undefined ? uniqueIds : [...new Set(targetIds)]
      if (stored.generation !== generation.current) return
      for (const id of targets) inFlight.current.delete(`${generation.current}\u0000${id}`)
      setStored((current) => {
        if (current.generation !== generation.current) return current
        const next = { ...current.entries }
        for (const id of targets) delete next[id]
        return { generation: generation.current, entries: next }
      })
      setRevision((value) => value + 1)
    },
    [uniqueIds, stored.generation],
  )

  useEffect(() => {
    if (remote === null || accountSub === null || uniqueIds.length === 0) return
    const currentGeneration = generation.current
    const missing = uniqueIds.filter(
      (id) => entries[id] === undefined && !inFlight.current.has(`${requestGeneration}\u0000${id}`),
    )
    if (missing.length === 0) return
    setStored((current) => {
      const next = current.generation === currentGeneration ? { ...current.entries } : {}
      for (const id of missing) next[id] = { kind: 'loading' }
      return { generation: currentGeneration, entries: next }
    })
    const current = () => generation.current === currentGeneration
    const batches: string[][] = []
    for (let index = 0; index < missing.length; index += BATCH_SIZE)
      batches.push(missing.slice(index, index + BATCH_SIZE))
    for (const batch of batches) {
      const tokens = new Map(
        batch.map((id) => {
          const key = `${currentGeneration}\u0000${id}`
          const token = ++requestSequence.current
          inFlight.current.set(key, token)
          return [id, token] as const
        }),
      )
      void googleCap
        .mailMarkerAnnotations(remote, { ids: batch, expectedAccountSub: accountSub })
        .then((result) => {
          if (!current()) return
          const decoded: StateMap = {}
          for (const id of batch) {
            const key = `${currentGeneration}\u0000${id}`
            if (inFlight.current.get(key) !== tokens.get(id)) continue
            inFlight.current.delete(key)
            const marker: unknown = result[id]
            if (marker === null || marker === undefined || isMailMarker(marker)) {
              decoded[id] = { kind: 'ready', marker: marker == null ? null : marker }
            } else {
              decoded[id] = { kind: 'error' }
            }
          }
          setStored((state) =>
            state.generation === currentGeneration
              ? { generation: currentGeneration, entries: { ...state.entries, ...decoded } }
              : state,
          )
        })
        .catch(() => {
          if (!current()) return
          const failedIds = batch.filter((id) => {
            const key = `${currentGeneration}\u0000${id}`
            if (inFlight.current.get(key) !== tokens.get(id)) return false
            inFlight.current.delete(key)
            return true
          })
          if (failedIds.length === 0) return
          setStored((state) => {
            if (state.generation !== currentGeneration) return state
            const failed = { ...state.entries }
            for (const id of failedIds) failed[id] = { kind: 'error' }
            return { generation: currentGeneration, entries: failed }
          })
        })
    }
    // `entries` is the rendered snapshot; `revision` deliberately retries only invalidated ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote, accountSub, idsKey, revision, requestGeneration])

  const get = useCallback(
    (id: string): MailMarkerStatus => entries[id] ?? { kind: 'loading' },
    [entries],
  )
  return { get, invalidate }
}
