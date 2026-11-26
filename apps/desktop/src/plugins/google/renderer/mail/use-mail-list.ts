import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { useAtomValue, useStore } from 'jotai'
import { activeRemoteRevisionValueAtom } from '@/plugin-api'
import { googleAccountRevisionAtom, mailContinuityAtom, useGoogleAccount } from '../account'
import { googleCap } from '../google-cap'
import { codeOf, explainWriteFailure, isDisconnected, messageOf } from '../google-errors'

type Page = Awaited<ReturnType<typeof googleCap.search>>
type Search = NonNullable<Parameters<typeof googleCap.search>[1]>
type Call = <T>(work: (remote: string) => Promise<T>) => Promise<T>

type Ready = Page & { kind: 'ready'; source: object; recoveryError?: string }

type ListState =
  | Ready
  | { kind: 'loading'; held?: Ready }
  | { kind: 'disconnected' }
  | { kind: 'error'; message: string }

/** Only rows already displayed for this actor and query may survive a failed scan. */
function heldPage(list: ListState, source: object): Ready | undefined {
  const page = list.kind === 'ready' ? list : list.kind === 'loading' ? list.held : undefined
  return page?.source === source ? page : undefined
}

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

  const { currentSub, loading, readError } = useGoogleAccount()
  const account = !loading && !readError ? currentSub : null
  const source = useMemo(
    () => ({ call, params, enabled, scopeIsCurrent, currentSub }),
    [call, params, enabled, scopeIsCurrent, currentSub],
  )
  const recovery = useRef<object | null>(null)
  const resetting = useRef<object | null>(null)
  const verifiedAccount = useRef(account)
  const liveSource = useRef<object | null>(source)
  useLayoutEffect(() => {
    verifiedAccount.current = account
    liveSource.current = source
    return () => {
      liveSource.current = null
    }
  }, [source, account])

  const read = useCallback(
    (mode: 'load' | 'refresh' | 'retry' | 'more', token?: string) => {
      if (
        !enabled ||
        liveSource.current !== source ||
        !scopeIsCurrent() ||
        resetting.current === source
      )
        return
      const more = mode === 'more'
      const retry = mode === 'retry'
      const force = retry || (mode === 'refresh' && recovery.current === source)
      if (!force && !more && recovery.current === source) return
      const account = verifiedAccount.current
      if (force && account === null) {
        setList({ kind: 'error', message: 'Could not verify your Google account. Try again.' })
        return
      }
      const at = ++request.current
      const inScope = () =>
        request.current === at && liveSource.current === source && scopeIsCurrent()
      paging.current = more || retry
      setWorking(more ? 'more' : retry ? 'retry' : null)
      if (!more && !retry) {
        generation.current++
        setList((previous) => ({ kind: 'loading', held: heldPage(previous, source) }))
      }
      const before = store.get(mailContinuityAtom)?.epoch
      if (force) {
        recovery.current = source
        resetting.current = source
      }
      const settle = force ? store.set(mailContinuityAtom, 'reset') : undefined
      let published = false
      const reportNotFound = watchNotFound()
      const options = force
        ? { ...params, refresh: true, expectedAccountSub: account! }
        : more
          ? { ...params, pageToken: token }
          : params
      void call((remote) => googleCap.search(remote, options))
        .then((page) => {
          published = !page.historyRecoveryRequired
          if (!inScope()) return
          // Exact absence can be known even when the history scan cannot publish a list.
          if (page.notFoundThreadIds) reportNotFound(page.notFoundThreadIds)
          if (page.historyRecoveryRequired) {
            recovery.current = source
            if (more || retry) generation.current++
            // A delta response from before a reset cannot retire that newer epoch.
            if (store.get(mailContinuityAtom)?.epoch === before)
              store.set(mailContinuityAtom, 'lost')
            const missing = new Set(page.notFoundThreadIds)
            const message =
              'Gmail history could not be checked. Try again to reload this mail list.'
            setList((previous) => {
              const held = heldPage(previous, source)
              return held === undefined
                ? { kind: 'error', message }
                : {
                    ...held,
                    threads: held.threads.filter(({ id }) => !missing.has(id)),
                    nextPageToken: null,
                    unreadableThreadIds: undefined,
                    recoveryError: message,
                  }
            })
            return
          }
          if (force && !page.unreadableThreadIds?.length) recovery.current = null
          if (more || retry) generation.current++
          setList((previous) => {
            if (!more) return { ...page, kind: 'ready', source }
            if (previous.kind !== 'ready' || previous.source !== source) return previous
            const replaced = new Set([
              ...page.threads.map(({ id }) => id),
              ...(page.unreadableThreadIds ?? []),
              ...(page.notFoundThreadIds ?? []),
            ])
            return {
              ...page,
              kind: 'ready',
              source,
              threads: [...previous.threads.filter(({ id }) => !replaced.has(id)), ...page.threads],
            }
          })
        })
        .catch((error: unknown) => {
          if (!inScope()) return
          if (!more || isDisconnected(error) || codeOf(error) === 'FORBIDDEN')
            setList(failure(error))
          else onPageError(explainWriteFailure(error))
        })
        .finally(() => {
          if (resetting.current === source && force) resetting.current = null
          // The snapshot can change continuity even if its list unmounted or
          // changed its query while the request was in flight.
          settle?.(published)
          if (!inScope()) return
          paging.current = false
          setWorking(null)
        })
    },
    [enabled, source, scopeIsCurrent, generation, store, watchNotFound, params, call, onPageError],
  )

  const load = useCallback(() => read('load'), [read])
  useLayoutEffect(
    () => () => {
      request.current++
      paging.current = false
    },
    [load],
  )
  useEffect(load, [load])

  return {
    list,
    setList,
    load,
    refresh: () => read('refresh'),
    loadMore: () => {
      if (!paging.current && list.kind === 'ready' && list.nextPageToken !== null)
        read('more', list.nextPageToken)
    },
    retryPartial: () => {
      if (!paging.current && list.kind === 'ready' && list.unreadableThreadIds?.length)
        read('retry')
    },
    working,
  }
}
