import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { googleCap } from '../google-cap'
import { codeOf, explainWriteFailure, isDisconnected, messageOf } from '../google-errors'

type Page = Awaited<ReturnType<typeof googleCap.search>>
type Search = NonNullable<Parameters<typeof googleCap.search>[1]>
type Call = <T>(work: (remote: string) => Promise<T>) => Promise<T>

type PartialPage = { pageToken: string | undefined; ids: string[] }
type Ready = Pick<Page, 'threads' | 'nextPageToken' | 'syncedAt'> & {
  kind: 'ready'
  partial: PartialPage[]
  tail: string | undefined
}

type ListState =
  Ready | { kind: 'loading' } | { kind: 'disconnected' } | { kind: 'error'; message: string }

function failure(error: unknown): ListState {
  return isDisconnected(error)
    ? { kind: 'disconnected' }
    : { kind: 'error', message: messageOf(error, 'Could not load your mail.') }
}

function partialPage(page: Page, pageToken: string | undefined): PartialPage[] {
  return page.unreadableThreadIds?.length ? [{ pageToken, ids: page.unreadableThreadIds }] : []
}

/** Both readers use the same paged load and read-only partial-page recovery. */
export function useMailList(
  call: Call,
  params: Search,
  enabled: boolean,
  generation: RefObject<number>,
  onPageError: (message: string) => void,
) {
  const [list, setList] = useState<ListState>({ kind: 'loading' })
  const [working, setWorking] = useState<'more' | 'retry' | null>(null)
  const request = useRef(0)
  const paging = useRef(false)

  const load = useCallback(() => {
    const at = ++request.current
    paging.current = false
    setWorking(null)
    if (!enabled) return
    generation.current++
    setList({ kind: 'loading' })
    void call((remote) => googleCap.search(remote, params)).then(
      (page) => {
        if (request.current !== at) return
        const { threads, nextPageToken, syncedAt } = page
        setList({
          kind: 'ready',
          threads,
          nextPageToken,
          syncedAt,
          partial: partialPage(page, undefined),
          tail: undefined,
        })
      },
      (error: unknown) => {
        if (request.current === at) setList(failure(error))
      },
    )
  }, [call, params, enabled, generation])
  useEffect(load, [load])

  const paginate = (mode: 'more' | 'retry') => {
    if (!enabled || list.kind !== 'ready' || paging.current) return
    const retry = mode === 'retry' ? list.partial[0] : undefined
    if (mode === 'retry' ? !retry : list.nextPageToken === null) return
    const pageToken = retry ? retry.pageToken : list.nextPageToken!
    const at = request.current
    paging.current = true
    setWorking(mode)
    void call((remote) => googleCap.search(remote, { ...params, pageToken }))
      .then((page) => {
        if (request.current !== at) return
        generation.current++
        setList((previous) => {
          if (previous.kind !== 'ready') return previous
          const partial = partialPage(page, pageToken)
          const { nextPageToken, syncedAt } = page
          if (!retry)
            return {
              kind: 'ready',
              nextPageToken,
              syncedAt,
              tail: pageToken,
              threads: [...previous.threads, ...page.threads],
              partial: [...previous.partial, ...partial],
            }
          // Retry the affected page, not the entire list. Retain healthy rows
          // and their local triage state; only restore newly readable rows.
          const unreadable = new Set(page.unreadableThreadIds)
          const kept = previous.threads.filter(({ id }) => !unreadable.has(id))
          const existing = new Set(kept.map(({ id }) => id))
          const failed = new Set(retry.ids)
          const recovered = page.threads.filter(({ id }) => failed.has(id) && !existing.has(id))
          return {
            ...previous,
            threads: recovered.length
              ? [...kept, ...recovered].sort((a, b) => b.date.localeCompare(a.date))
              : kept,
            nextPageToken: previous.tail === pageToken ? nextPageToken : previous.nextPageToken,
            // A persistent refusal on one page must not starve later retries.
            partial: [...previous.partial.slice(1), ...partial],
          }
        })
      })
      .catch((error: unknown) => {
        if (request.current !== at) return
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
