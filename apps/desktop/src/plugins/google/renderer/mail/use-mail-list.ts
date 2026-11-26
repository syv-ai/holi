import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useAtomValue, useStore } from 'jotai'
import { activeRemoteRevisionValueAtom } from '@/plugin-api'
import { googleAccountRevisionAtom } from '../account'
import { googleCap } from '../google-cap'
import { codeOf, explainWriteFailure, isDisconnected, messageOf } from '../google-errors'

type Page = Awaited<ReturnType<typeof googleCap.search>>
type Search = NonNullable<Parameters<typeof googleCap.search>[1]>
type Call = <T>(work: (remote: string) => Promise<T>) => Promise<T>

type Ready = Page & { kind: 'ready' }

type ListState =
  Ready | { kind: 'loading' } | { kind: 'disconnected' } | { kind: 'error'; message: string }

function failure(error: unknown): ListState {
  return isDisconnected(error)
    ? { kind: 'disconnected' }
    : { kind: 'error', message: messageOf(error, 'Could not load your mail.') }
}

/** Both readers use the same paged load and read-only partial-page recovery. */
export function useMailList(
  call: Call,
  params: Search,
  enabled: boolean,
  generation: RefObject<number>,
  onPageError: (message: string) => void,
  watchNotFound: () => (ids: readonly string[]) => void,
) {
  const [list, setList] = useState<ListState>({ kind: 'loading' })
  const [working, setWorking] = useState<'more' | 'retry' | null>(null)
  const request = useRef(0)
  const paging = useRef(false)
  const remoteRevision = useAtomValue(activeRemoteRevisionValueAtom)
  const accountRevision = useAtomValue(googleAccountRevisionAtom)
  const store = useStore()
  const scopeIsCurrent = useCallback(
    () =>
      store.get(activeRemoteRevisionValueAtom) === remoteRevision &&
      store.get(googleAccountRevisionAtom) === accountRevision,
    [store, remoteRevision, accountRevision],
  )

  const load = useCallback(() => {
    if (!scopeIsCurrent()) return
    const at = ++request.current
    paging.current = false
    setWorking(null)
    if (!enabled) return
    generation.current++
    setList({ kind: 'loading' })
    const reportNotFound = watchNotFound()
    void call((remote) => googleCap.search(remote, params)).then(
      (page) => {
        if (request.current !== at || !scopeIsCurrent()) return
        if (page.notFoundThreadIds) reportNotFound(page.notFoundThreadIds)
        setList({ ...page, kind: 'ready' })
      },
      (error: unknown) => {
        if (request.current === at && scopeIsCurrent()) setList(failure(error))
      },
    )
  }, [call, params, enabled, generation, scopeIsCurrent, watchNotFound])
  useLayoutEffect(
    () => () => {
      request.current++
    },
    [load],
  )
  useEffect(load, [load])

  const paginate = (mode: 'more' | 'retry') => {
    if (!enabled || list.kind !== 'ready' || paging.current || !scopeIsCurrent()) return
    const retry = mode === 'retry'
    if (retry ? !list.unreadableThreadIds?.length : list.nextPageToken === null) return
    const at = request.current
    paging.current = true
    setWorking(mode)
    const options = retry
      ? { ...params, refresh: true }
      : { ...params, pageToken: list.nextPageToken! }
    const reportNotFound = watchNotFound()
    void call((remote) => googleCap.search(remote, options))
      .then((page) => {
        if (request.current !== at || !scopeIsCurrent()) return
        if (page.notFoundThreadIds) reportNotFound(page.notFoundThreadIds)
        generation.current++
        setList((previous) => {
          if (previous.kind !== 'ready') return previous
          // Keep the current rows while the retry runs, then replace them
          // together with the cursor. Newly arrived mail may have moved every
          // page boundary, so old rows cannot be paired with a fresh token.
          if (retry) return { ...page, kind: 'ready' }
          const replaced = new Set([
            ...page.threads.map(({ id }) => id),
            ...(page.unreadableThreadIds ?? []),
            ...(page.notFoundThreadIds ?? []),
          ])
          return {
            ...page,
            kind: 'ready',
            threads: [...previous.threads.filter(({ id }) => !replaced.has(id)), ...page.threads],
          }
        })
      })
      .catch((error: unknown) => {
        if (request.current !== at || !scopeIsCurrent()) return
        if (retry || isDisconnected(error) || codeOf(error) === 'FORBIDDEN') setList(failure(error))
        else onPageError(explainWriteFailure(error))
      })
      .finally(() => {
        if (request.current !== at) return
        paging.current = false
        setWorking(null)
      })
  }

  return {
    list,
    setList,
    load,
    loadMore: () => paginate('more'),
    retryPartial: () => paginate('retry'),
    working,
  }
}
