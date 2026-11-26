import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useAtomValue, useStore } from 'jotai'
import { activeRemoteAtom, activeRemoteRevisionValueAtom } from '@/plugin-api'
import { googleAccountRevisionAtom, useGoogleAccount } from '../account'
import { googleCap } from '../google-cap'
import { messageOf } from '../google-errors'

type Thread = Awaited<ReturnType<typeof googleCap.thread>>

interface Reader {
  id: string | null
  thread: Thread | null
  refreshing: boolean
  failure: { kind: 'missing' } | { kind: 'read'; message: string } | null
  generation: number
}

const idle: Reader = { id: null, thread: null, refreshing: false, failure: null, generation: 0 }

/** One selection and generation own the thread read and its invitation lifetime.
 * A refresh keeps the body (and the composer beside it) mounted. */
export function useMailThread() {
  const [reader, setReader] = useState(idle)
  const selection = useRef<{ id: string; readAt: number } | null>(null)
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

  const fetchThread = (id: string, mode: 'open' | 'refresh' = 'open') => {
    if (!actorIsCurrent()) return
    const at = ++generation.current
    const selected =
      mode === 'refresh' && selection.current?.id === id ? selection.current : { id, readAt: at }
    selection.current = selected
    setReader((previous) => ({
      id,
      thread: mode === 'refresh' && previous.id === id ? previous.thread : null,
      refreshing: mode === 'refresh',
      failure:
        mode === 'refresh' && previous.id === id && previous.failure?.kind === 'missing'
          ? previous.failure
          : null,
      generation: at,
    }))
    const fail = (message: string) => {
      if (generation.current !== at) return
      setReader((previous) => ({
        ...previous,
        refreshing: false,
        failure:
          previous.failure?.kind === 'missing' ? previous.failure : { kind: 'read', message },
      }))
    }
    void (
      remote === null
        ? Promise.reject(new Error('No vault is open.'))
        : googleCap.thread(remote, { id })
    ).then(
      (thread) => {
        if (generation.current !== at) return
        if (!actorIsCurrent()) {
          fail('The mail connection changed while loading this thread.')
          return
        }
        selected.readAt = at
        setReader({ id, thread, refreshing: false, failure: null, generation: at })
      },
      (error: unknown) =>
        fail(
          actorIsCurrent()
            ? messageOf(error, 'Could not load this thread.')
            : 'The mail connection changed while loading this thread.',
        ),
    )
  }

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
    return (ids: readonly string[]) => {
      if (
        account === null ||
        verifiedAccount.current !== account ||
        selected === null ||
        selection.current !== selected ||
        selected.readAt > at ||
        !ids.includes(selected.id)
      )
        return
      const missingGeneration = ++generation.current
      setReader((previous) => ({
        ...previous,
        refreshing: false,
        failure: { kind: 'missing' },
        generation: missingGeneration,
      }))
    }
  }, [])

  const { failure, ...view } = reader
  const at = reader.generation
  const isCurrentGeneration = useCallback(() => generation.current === at, [at])
  const error = reader.refreshing
    ? null
    : failure?.kind === 'missing'
      ? 'This thread is no longer available in Gmail.'
      : (failure?.message ?? null)
  return {
    ...view,
    error,
    isCurrentGeneration,
    actorIsCurrent,
    fetchThread,
    closeThread,
    watchNotFound,
    retry: () => {
      if (reader.id !== null && isCurrentGeneration()) fetchThread(reader.id, 'refresh')
    },
  }
}
