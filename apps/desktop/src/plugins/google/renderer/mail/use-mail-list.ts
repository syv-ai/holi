import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { googleCap } from '../google-cap'
import { explainWriteFailure, isDisconnected, messageOf } from '../google-errors'

type Page = Awaited<ReturnType<typeof googleCap.search>>
type Summary = Page['threads'][number]
type Params = NonNullable<Parameters<typeof googleCap.search>[1]>
type Counts = Awaited<ReturnType<typeof googleCap.mailCounts>>
type CategoryCounts = Awaited<ReturnType<typeof googleCap.categoryCounts>>
type List =
  | { kind: 'loading' }
  | { kind: 'ready'; threads: Summary[]; nextPageToken: string | null; syncedAt: string }
  | { kind: 'disconnected' }
  | { kind: 'error'; message: string }

/** Owns a mounted Mail list: incremental reads, continuation, counts and optimistic
 * writes share one lifetime. Searches remain manual; hidden owners accept no results.
 * Marker operations use the same write seam, retaining their own overlay/error UI. */
export function useMailList({
  remote,
  account,
  visible,
  drafts,
  supported,
  params,
}: {
  remote: string | null
  account: string | null
  visible: boolean
  drafts: boolean
  supported: boolean
  params: Params
}) {
  const activation = useMemo(() => ({ remote, account, categories: false }), [remote, account])
  const key = JSON.stringify([remote, account, visible, drafts, supported, params])
  const owner = useMemo(
    () => ({
      key,
      live: false,
      revision: 0,
      request: 0,
      countsRequest: 0,
      categoryRequest: 0,
      pending: false,
      more: false,
      writes: 0,
      reconcile: false,
      cursor: undefined as NonNullable<Page['uiList']>['cursor'] | undefined,
      list: { kind: 'loading' } as List,
    }),
    [key],
  )
  const current = useRef(owner)
  current.current = owner
  const [listState, setListState] = useState<{ owner: typeof owner; value: List }>()
  const [countsState, setCountsState] = useState<{ owner: typeof owner; value: Counts }>()
  const [categoryState, setCategoryState] = useState<{
    owner: typeof owner
    value: CategoryCounts | null
  }>()
  const [loadingMore, setLoadingMore] = useState(false)
  const [writeError, setWriteError] = useState<string | null>(null)
  const active = useCallback(() => current.current === owner && owner.live, [owner])
  const paint = useCallback(
    (value: List) => {
      owner.list = value
      setListState({ owner, value })
    },
    [owner],
  )
  const loadCounts = useCallback(() => {
    if (!active() || remote === null || account === null || owner.writes > 0) return
    const revision = owner.revision
    const at = ++owner.countsRequest
    void googleCap
      .mailCounts(remote)
      .then((value) => {
        if (active() && owner.revision === revision && owner.countsRequest === at)
          setCountsState({ owner, value })
      })
      .catch(() => undefined)
    if (activation.categories) {
      const categoryAt = ++owner.categoryRequest
      void googleCap
        .categoryCounts(remote)
        .then((value) => {
          if (active() && owner.revision === revision && owner.categoryRequest === categoryAt)
            setCategoryState({ owner, value })
        })
        .catch(() => undefined)
    }
  }, [active, owner, remote, account, activation])
  const read = useCallback(
    async (kind: 'initial' | 'manual' | 'poll' | 'more') => {
      if (!active()) return
      if (account === null) {
        paint({ kind: 'disconnected' })
        return
      }
      if (remote === null) {
        paint({ kind: 'error', message: 'No vault is open.' })
        return
      }
      if (
        kind === 'poll' &&
        (!supported || drafts || owner.pending || owner.more || owner.writes > 0)
      )
        return
      if (owner.writes > 0) {
        owner.reconcile = true
        return
      }
      if (
        kind === 'more' &&
        (owner.pending ||
          owner.more ||
          owner.list.kind !== 'ready' ||
          owner.list.nextPageToken === null)
      )
        return
      if (drafts) {
        loadCounts()
        return
      }
      const previous = owner.list
      const append = kind === 'more'
      const refresh = supported && previous.kind === 'ready' && !append
      owner.countsRequest++
      owner.categoryRequest++
      const at = ++owner.request
      const revision = owner.revision
      owner.pending = !append
      owner.more = append
      setLoadingMore(append)
      if (!append && kind !== 'poll') setListState({ owner, value: { kind: 'loading' } })
      const valid = () => active() && owner.request === at && owner.revision === revision
      try {
        const page = await googleCap.search(remote, {
          ...params,
          ...(append && previous.kind === 'ready' ? { pageToken: previous.nextPageToken! } : {}),
          ...(supported
            ? {
                uiList: {
                  loadedIds:
                    previous.kind === 'ready' ? previous.threads.map((thread) => thread.id) : [],
                  ...(owner.cursor === undefined ? {} : { cursor: owner.cursor }),
                  ...(refresh ? { refresh: true } : {}),
                },
              }
            : {}),
        })
        if (!valid()) return
        if (!append) owner.cursor = page.uiList?.cursor
        const retained = (append || refresh) && previous.kind === 'ready' ? previous.threads : []
        const rows = new Map(retained.map((thread) => [thread.id, thread]))
        for (const id of page.uiList?.removedIds ?? []) rows.delete(id)
        for (const thread of page.threads) rows.set(thread.id, thread)
        paint({
          kind: 'ready',
          threads: [...rows.values()].sort(
            (a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id),
          ),
          nextPageToken: page.nextPageToken,
          syncedAt: page.syncedAt,
        })
        loadCounts()
      } catch (cause) {
        if (!valid()) return
        if (append) setWriteError(explainWriteFailure(cause))
        else if (kind === 'poll' && previous.kind === 'ready') paint(previous)
        else
          setListState({
            owner,
            value: isDisconnected(cause)
              ? { kind: 'disconnected' }
              : { kind: 'error', message: messageOf(cause, 'Could not load your mail.') },
          })
      } finally {
        if (active() && owner.request === at) {
          owner.pending = false
          owner.more = false
          setLoadingMore(false)
        }
      }
    },
    [active, remote, account, supported, drafts, owner, params, paint, loadCounts],
  )
  const latestRead = useRef(read)
  latestRead.current = read
  useEffect(() => {
    owner.live = visible
    setWriteError(null)
    setLoadingMore(false)
    if (visible) {
      void latestRead.current('initial')
      loadCounts()
    }
    const timer = window.setInterval(() => {
      if (visible && account !== null) void latestRead.current('poll')
    }, 30_000)
    return () => {
      owner.live = false
      owner.request++
      owner.countsRequest++
      owner.categoryRequest++
      window.clearInterval(timer)
    }
  }, [owner, visible, account, loadCounts])

  const write = async (
    mutate: () => Promise<unknown>,
    next: (threads: Summary[]) => Summary[] = (threads) => threads,
  ): Promise<boolean> => {
    if (!active()) return false
    const snapshot = owner.list
    const revision = ++owner.revision
    owner.request++
    owner.pending = false
    owner.more = false
    setLoadingMore(false)
    owner.writes++
    setWriteError(null)
    if (snapshot.kind === 'ready') paint({ ...snapshot, threads: next(snapshot.threads) })
    try {
      await mutate()
      return active()
    } catch (cause) {
      if (active()) {
        if (owner.revision === revision) paint(snapshot)
        else owner.reconcile = true
        setWriteError(explainWriteFailure(cause))
      }
      return false
    } finally {
      owner.writes--
      if (active() && owner.writes === 0) {
        loadCounts()
        if (owner.reconcile) {
          owner.reconcile = false
          void latestRead.current('manual')
        }
      }
    }
  }
  return {
    list: listState?.owner === owner ? listState.value : owner.list,
    counts: countsState?.owner === owner ? countsState.value : null,
    categoryCounts: categoryState?.owner === owner ? categoryState.value : null,
    loadingMore,
    writeError,
    reportError: (message: string | null) => setWriteError(message),
    load: () => {
      void read('manual')
    },
    loadMore: () => {
      void read('more')
    },
    loadCategoryCounts: () => {
      activation.categories = true
      loadCounts()
    },
    write,
    markerChanged: (id: string, starred: boolean) => {
      if (!active()) return
      owner.revision++
      if (owner.list.kind === 'ready')
        paint({
          ...owner.list,
          threads: owner.list.threads.map((thread) =>
            thread.id === id ? { ...thread, starred } : thread,
          ),
        })
    },
  }
}
