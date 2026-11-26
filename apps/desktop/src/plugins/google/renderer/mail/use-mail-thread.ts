import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { useAtomValue, useStore } from 'jotai'
import { activeRemoteAtom, activeRemoteRevisionValueAtom } from '@/plugin-api'
import { googleAccountRevisionAtom, mailContinuityAtom, useGoogleAccount } from '../account'
import { googleCap } from '../google-cap'
import { codeOf, messageOf } from '../google-errors'

type Thread = Awaited<ReturnType<typeof googleCap.thread>>

interface Reader {
  id: string | null
  thread: Thread | null
  refreshing: boolean
  failure: { kind: 'missing' } | { kind: 'read'; message: string } | null
  generation: number
  epoch: object | undefined
  recovery: boolean
}

const idle: Reader = {
  id: null,
  thread: null,
  refreshing: false,
  failure: null,
  generation: 0,
  epoch: undefined,
  recovery: false,
}

/** One selection and generation own the thread read and its invitation lifetime.
 * A refresh keeps the body (and the composer beside it) mounted. */
export function useMailThread() {
  const [reader, setReader] = useState(idle)
  const selection = useRef<{
    id: string
    readAt: number
    remoteRevision: number
    account: string | null
  } | null>(null)
  const generation = useRef(0)
  const remote = useAtomValue(activeRemoteAtom)
  const remoteRevision = useAtomValue(activeRemoteRevisionValueAtom)
  const accountRevision = useAtomValue(googleAccountRevisionAtom)
  const { currentSub, loading, readError } = useGoogleAccount()
  const verified = currentSub !== null && !loading && !readError
  const verifiedAccount = useRef<string | null>(null)
  useLayoutEffect(() => {
    verifiedAccount.current = verified ? currentSub : null
  }, [verified, currentSub])
  const store = useStore()
  const continuity = useAtomValue(mailContinuityAtom)
  const actorIsCurrent = () =>
    store.get(activeRemoteAtom) === remote &&
    store.get(activeRemoteRevisionValueAtom) === remoteRevision &&
    store.get(googleAccountRevisionAtom) === accountRevision

  useLayoutEffect(
    () => () => {
      generation.current++
      selection.current = null
    },
    [],
  )

  const fetchThread = (id: string, mode: 'open' | 'refresh' | 'recover' = 'open') => {
    if (!actorIsCurrent()) return
    const current = store.get(mailContinuityAtom)
    const epoch = current?.epoch
    const recover =
      mode === 'recover' ||
      (mode === 'open' && current?.lost === true && !current.pending) ||
      (mode === 'refresh' && (reader.recovery || epoch !== reader.epoch))
    if (recover && current?.pending) return
    const account = verifiedAccount.current
    const opening = selection.current
    if (
      mode !== 'open' &&
      opening &&
      (opening.id !== id ||
        opening.remoteRevision !== remoteRevision ||
        (account !== null && opening.account !== null && opening.account !== account))
    )
      return
    const at = ++generation.current
    const selected =
      mode !== 'open' && opening ? opening : { id, readAt: at, remoteRevision, account }
    selection.current = selected
    setReader((previous) => ({
      id,
      thread: mode !== 'open' && previous.id === id ? previous.thread : null,
      refreshing: mode !== 'open',
      failure:
        mode !== 'open' && previous.id === id && previous.failure?.kind === 'missing'
          ? previous.failure
          : null,
      generation: at,
      // Only a completed exact read can verify a selection across a reset.
      epoch: recover || current?.pending || current?.lost ? previous.epoch : epoch,
      recovery: recover,
    }))
    const ownsRead = () =>
      generation.current === at &&
      actorIsCurrent() &&
      store.get(mailContinuityAtom)?.epoch === epoch
    const fail = (error: unknown) => {
      if (!ownsRead()) return
      setReader((previous) => ({
        ...previous,
        epoch: recover ? epoch : previous.epoch,
        refreshing: false,
        failure:
          (recover && codeOf(error) === 'NOT_FOUND') || previous.failure?.kind === 'missing'
            ? { kind: 'missing' }
            : { kind: 'read', message: messageOf(error, 'Could not load this thread.') },
      }))
    }
    void (
      remote === null || (recover && account === null)
        ? Promise.reject(new Error('Could not verify the Google account for this thread.'))
        : googleCap.thread(remote, recover ? { id, expectedAccountSub: account! } : { id })
    ).then((thread) => {
      if (!ownsRead()) return
      selected.readAt = at
      setReader({
        id,
        thread,
        refreshing: false,
        failure: null,
        generation: at,
        epoch: recover || (!current?.lost && !current?.pending) ? epoch : undefined,
        recovery: false,
      })
    }, fail)
  }

  const revalidate = useEffectEvent((epoch: object | undefined) => {
    const selected = selection.current
    if (
      selected !== null &&
      reader.epoch !== epoch &&
      store.get(mailContinuityAtom)?.epoch === epoch
    )
      fetchThread(selected.id, 'recover')
  })
  useEffect(() => {
    if (verified && !continuity?.pending && !continuity?.lost) revalidate(continuity?.epoch)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Effect Events are non-reactive; this rule predates React 19.2.
  }, [continuity, verified])

  const closeThread = () => {
    selection.current = null
    setReader({ ...idle, generation: ++generation.current })
  }

  // A page request captures only the opening it can speak for. A newer successful
  // read supersedes it, but an unconfirmed refresh does not. Invalidate the
  // invitation before React commits: binding validation alone cannot tell a
  // pending Join that the thread is gone.
  const watchNotFound = useCallback(() => {
    const account = verifiedAccount.current
    const selected = selection.current
    const at = generation.current
    const epoch = store.get(mailContinuityAtom)?.epoch
    return (ids: readonly string[]) => {
      if (
        account === null ||
        verifiedAccount.current !== account ||
        selected === null ||
        selection.current !== selected ||
        selected.readAt > at ||
        store.get(mailContinuityAtom)?.epoch !== epoch ||
        !ids.includes(selected.id)
      )
        return
      const missingGeneration = ++generation.current
      const pending = store.get(mailContinuityAtom)?.pending
      setReader((previous) => ({
        ...previous,
        refreshing: false,
        failure: { kind: 'missing' },
        epoch: pending ? previous.epoch : epoch,
        generation: missingGeneration,
      }))
    }
  }, [store])

  const { failure, ...view } = reader
  const at = reader.generation
  const epoch = reader.epoch
  const isCurrentGeneration = useCallback(() => {
    const current = store.get(mailContinuityAtom)
    return generation.current === at && current?.epoch === epoch && !current?.pending
  }, [at, epoch, store])
  const needsVerification = reader.id !== null && continuity?.epoch !== epoch
  const refreshing =
    reader.refreshing ||
    (needsVerification && Boolean(continuity?.pending || (verified && !continuity?.lost)))
  const error = refreshing
    ? null
    : needsVerification
      ? 'Gmail history could not be checked. Retry to check this thread directly.'
      : failure?.kind === 'missing'
        ? 'This thread is no longer available in Gmail.'
        : (failure?.message ?? null)
  return {
    ...view,
    refreshing,
    error,
    isCurrentGeneration,
    actorIsCurrent,
    fetchThread,
    closeThread,
    watchNotFound,
    retry: () => {
      if (reader.id !== null && generation.current === at) fetchThread(reader.id, 'refresh')
    },
  }
}
