/**
 * The mail view's state and every Gmail call it makes, through Google's
 * capabilities at the UI door (`googleCap`), for the open vault.
 *
 * The rules are the ones `MailView` follows (docs/features/google.md): writes
 * paint first and revert on refusal, archive and trash raise one toast with
 * Undo, a search escapes the place it was started from, and "unread only" is a
 * state that survives it. Nothing here touches main beyond those calls.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import { activeRemoteAtom } from '@/plugin-api'
import { googleCap } from '../account'
import { explainWriteFailure, isDisconnected, messageOf } from '../google-errors'
import type { MailAddress, ThreadMessage } from '../mail-types'
import type { MailFolder } from './data'

/** Gmail's own shapes, as the capabilities return them. */
type SearchPage = Awaited<ReturnType<typeof googleCap.search>>
export type ThreadSummary = SearchPage['threads'][number]
export type Thread = Awaited<ReturnType<typeof googleCap.thread>>
export type DraftSummary = Awaited<ReturnType<typeof googleCap.drafts>>[number]
export type MailCounts = NonNullable<Awaited<ReturnType<typeof googleCap.mailCounts>>>
export type CategoryCounts = Awaited<ReturnType<typeof googleCap.categoryCounts>>
export type MailCategory = NonNullable<
  NonNullable<Parameters<typeof googleCap.search>[1]>['category']
>
export type ThreadMeeting = NonNullable<Awaited<ReturnType<typeof googleCap.meeting>>>
export type { MailAddress }

export type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; threads: ThreadSummary[]; nextPageToken: string | null }
  | { kind: 'disconnected' }
  | { kind: 'error'; message: string }

export type DraftsState =
  | { kind: 'loading' }
  | { kind: 'ready'; drafts: DraftSummary[] }
  | { kind: 'error'; message: string }

export type ReaderState =
  | { kind: 'idle' }
  | { kind: 'loading'; id: string }
  | { kind: 'ready'; thread: Thread }
  | { kind: 'error'; id: string; message: string }

/**
 * The message a reply answers: the last one the account did not send, else
 * the last. The rule `replyToThread` applies in main, so a reply is never
 * addressed to its own author.
 */
export function replyTarget(thread: Thread, sendAs: readonly string[]): ThreadMessage | null {
  if (thread.messages.length === 0) return null
  const mine = new Set(sendAs.map((address) => address.toLowerCase()))
  const inbound = [...thread.messages]
    .reverse()
    .find((message) => !mine.has(message.from.email.toLowerCase()))
  return inbound ?? thread.messages[thread.messages.length - 1]!
}

/**
 * `account` is the Google account the vault reads from (its `sub`): a switch
 * of account re-asks everything, as a switch of vault does.
 */
export function useMail(account: string | null) {
  const remote = useAtomValue(activeRemoteAtom)
  /** One of Google's calls, for the open vault; refused with none open. */
  const call = useCallback(
    <T>(work: (remote: string) => Promise<T>): Promise<T> =>
      remote === null ? Promise.reject(new Error('No vault is open.')) : work(remote),
    // `account` is a dependency on purpose: every call reruns after a switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [remote, account],
  )

  const [folder, setFolderState] = useState<MailFolder>('inbox')
  /** A Gmail tab inside the inbox; null is the whole inbox. */
  const [category, setCategory] = useState<MailCategory | null>(null)
  const [unreadOnly, setUnreadOnly] = useState(false)
  /** The query actually fetched: typing does not spend a request per key. */
  const [submitted, setSubmitted] = useState('')
  const [list, setList] = useState<ListState>({ kind: 'loading' })
  const [drafts, setDrafts] = useState<DraftsState>({ kind: 'loading' })
  const [draftsGeneration, setDraftsGeneration] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [counts, setCounts] = useState<MailCounts | null>(null)
  const [categoryCounts, setCategoryCounts] = useState<CategoryCounts | null>(null)
  const [contacts, setContacts] = useState<MailAddress[]>([])
  const [sendAs, setSendAs] = useState<string[]>([])
  const [writeError, setWriteError] = useState<string | null>(null)
  const [reader, setReader] = useState<ReaderState>({ kind: 'idle' })
  const [openSummary, setOpenSummary] = useState<ThreadSummary | null>(null)
  /** Keyed by the thread it was asked about, so a late answer never gives the
   *  next thread the previous one's Join button. */
  const [meeting, setMeeting] = useState<(ThreadMeeting & { threadId: string }) | null>(null)
  /** Bumped by everything that replaces the list, so a refused write knows
   *  whether its snapshot is still a valid undo. */
  const listGeneration = useRef(0)
  /** The latest list request: an older answer landing late is dropped. */
  const listRequest = useRef(0)

  const searching = submitted !== ''
  const showsDrafts = folder === 'drafts' && !searching
  /** What narrows the request. A search escapes the folder and the tab;
   *  unread survives it, and does not apply to Sent or Drafts. */
  const params = useMemo(() => {
    if (searching)
      return {
        query: submitted,
        unread: unreadOnly && folder !== 'sent' ? true : undefined,
      }
    if (folder === 'sent') return { mailbox: 'sent' as const }
    if (folder === 'starred') return { query: 'is:starred', unread: unreadOnly ? true : undefined }
    return {
      category: category ?? undefined,
      unread: unreadOnly ? true : undefined,
    }
  }, [searching, submitted, unreadOnly, folder, category])

  const load = useCallback(() => {
    if (showsDrafts) return
    setList({ kind: 'loading' })
    listGeneration.current++
    const at = ++listRequest.current
    void call((r) => googleCap.search(r, params))
      .then((page) => {
        if (listRequest.current !== at) return
        setList({
          kind: 'ready',
          threads: page.threads,
          nextPageToken: page.nextPageToken,
        })
      })
      .catch((err: unknown) => {
        if (listRequest.current !== at) return
        setList(
          isDisconnected(err)
            ? { kind: 'disconnected' }
            : {
                kind: 'error',
                message: messageOf(err, 'Could not load your mail.'),
              },
        )
      })
  }, [call, params, showsDrafts])

  useEffect(load, [load])

  useEffect(() => {
    if (!showsDrafts) return
    let cancelled = false
    setDrafts({ kind: 'loading' })
    void call((r) => googleCap.drafts(r))
      .then((result) => !cancelled && setDrafts({ kind: 'ready', drafts: result }))
      .catch(
        (err: unknown) =>
          !cancelled &&
          setDrafts({
            kind: 'error',
            message: messageOf(err, 'Could not load your drafts.'),
          }),
      )
    return () => {
      cancelled = true
    }
  }, [call, showsDrafts, draftsGeneration])

  /** Exact counts from Gmail's bookkeeping; a failure only loses the number. */
  const loadCounts = useCallback(() => {
    void call((r) => googleCap.mailCounts(r))
      .then(setCounts)
      .catch(() => setCounts(null))
  }, [call])
  useEffect(loadCounts, [loadCounts])

  /** Unread per Gmail tab: five requests, so only once the tab menu opens. */
  const loadCategoryCounts = useCallback(() => {
    void call((r) => googleCap.categoryCounts(r))
      .then(setCategoryCounts)
      .catch(() => setCategoryCounts(null))
  }, [call])

  // The address book and the send-as aliases, once per vault. Both fail
  // quietly: completion still works off loaded senders, and an empty send-as
  // list only means a reply-all may copy the person on their own reply.
  useEffect(() => {
    void call((r) => googleCap.contacts(r))
      .then(setContacts)
      .catch(() => setContacts([]))
    void call((r) => googleCap.sendAs(r))
      .then(setSendAs)
      .catch(() => setSendAs([]))
  }, [call])

  const refresh = () => {
    if (showsDrafts) setDraftsGeneration((n) => n + 1)
    else load()
    loadCounts()
    if (categoryCounts !== null) loadCategoryCounts()
  }

  /** The next page, appended. A button, not an infinite scroll: Gmail is
   *  rate limited and one flick would spend a minute's quota. */
  const loadMore = () => {
    if (list.kind !== 'ready' || list.nextPageToken === null) return
    const pageToken = list.nextPageToken
    setLoadingMore(true)
    void call((r) => googleCap.search(r, { ...params, pageToken }))
      .then((page) => {
        listGeneration.current++
        setList((previous) =>
          previous.kind === 'ready'
            ? {
                kind: 'ready',
                threads: [...previous.threads, ...page.threads],
                nextPageToken: page.nextPageToken,
              }
            : previous,
        )
      })
      .catch((err: unknown) => setWriteError(explainWriteFailure(err)))
      .finally(() => setLoadingMore(false))
  }

  /**
   * A write, painted at once and undone if Google refuses. Optimism lives
   * here and nowhere below: main updates its cache only once Google agreed.
   * Resolves true once it has.
   */
  const write = async (
    mutate: () => Promise<unknown>,
    next: (threads: ThreadSummary[]) => ThreadSummary[],
  ): Promise<boolean> => {
    const snapshot = list.kind === 'ready' ? list.threads : null
    const at = ++listGeneration.current
    setWriteError(null)
    setList((previous) =>
      previous.kind === 'ready' ? { ...previous, threads: next(previous.threads) } : previous,
    )
    try {
      await mutate()
      return true
    } catch (err: unknown) {
      if (listGeneration.current === at && snapshot !== null) {
        setList((previous) =>
          previous.kind === 'ready' ? { ...previous, threads: snapshot } : previous,
        )
      } else {
        load()
      }
      setWriteError(explainWriteFailure(err))
      return false
    }
  }

  const setRead = (id: string, read: boolean) =>
    write(
      () => call((r) => googleCap['mark-read'](r, { id, unread: !read })),
      (threads) => threads.map((t) => (t.id === id ? { ...t, unread: !read } : t)),
    )

  const setStarred = (id: string, starred: boolean) =>
    write(
      () => call((r) => googleCap.star(r, { id, off: !starred })),
      (threads) => threads.map((t) => (t.id === id ? { ...t, starred } : t)),
    )

  const openId =
    reader.kind === 'idle' ? null : reader.kind === 'ready' ? reader.thread.id : reader.id

  const closeThread = () => {
    setReader({ kind: 'idle' })
    setOpenSummary(null)
    setMeeting(null)
  }

  /**
   * Archive or trash, then one toast that stays until dismissed and offers
   * Undo: a frequent, reversible removal earns undo, not a confirmation.
   */
  const removeThreads = async (ids: readonly string[], kind: 'archive' | 'trash') => {
    if (openId !== null && ids.includes(openId)) closeThread()
    const done = await Promise.all(
      ids.map((id) =>
        write(
          () => call((r) => googleCap[kind](r, { id })),
          (threads) => threads.filter((t) => t.id !== id),
        ),
      ),
    )
    const moved = ids.filter((_, index) => done[index])
    if (moved.length === 0) return
    const subject = moved.length === 1 ? 'Thread' : `${moved.length} threads`
    toast(kind === 'archive' ? `${subject} archived` : `${subject} moved to Trash`, {
      duration: Infinity,
      closeButton: true,
      action: {
        label: 'Undo',
        onClick: () => {
          const inverse = kind === 'archive' ? googleCap.unarchive : googleCap.untrash
          void Promise.all(moved.map((id) => call((r) => inverse(r, { id }))))
            .catch((err: unknown) => setWriteError(explainWriteFailure(err)))
            .finally(load)
        },
      },
    })
  }

  const fetchThread = (id: string) => {
    setReader({ kind: 'loading', id })
    void call((r) => googleCap.thread(r, { id }))
      .then((thread) =>
        setReader((current) =>
          current.kind === 'loading' && current.id === id ? { kind: 'ready', thread } : current,
        ),
      )
      .catch((err: unknown) =>
        setReader((current) =>
          current.kind === 'loading' && current.id === id
            ? {
                kind: 'error',
                id,
                message: messageOf(err, 'Could not load this thread.'),
              }
            : current,
        ),
      )
  }

  /** Open a thread, keeping its row: flags such as the unsubscribe link come
   *  from the list and are not refetched. */
  const openThread = (thread: ThreadSummary) => {
    setOpenSummary(thread)
    setMeeting(null)
    fetchThread(thread.id)
    // Only for a thread the list says holds an invite: a second request per
    // open otherwise. A failure is swallowed; the row already says "meeting".
    if (thread.hasInvite) {
      void call((r) => googleCap.meeting(r, { id: thread.id }))
        .then((found) => {
          if (found !== null) setMeeting({ ...found, threadId: thread.id })
        })
        .catch(() => undefined)
    }
    if (thread.unread) void setRead(thread.id, true)
  }

  /** Re-read the open thread, after a send or a failed load. */
  const reloadThread = () => {
    if (openId !== null) fetchThread(openId)
  }

  const threads = useMemo(() => (list.kind === 'ready' ? list.threads : []), [list])
  /** The open thread's row as the list has it now (flags move there), else
   *  as it was when opened. */
  const openRow = threads.find((thread) => thread.id === openId) ?? openSummary

  const setFolder = (next: MailFolder) => {
    setFolderState(next)
    setSubmitted('')
    if (next !== 'inbox') setCategory(null)
  }

  return {
    remote,
    folder,
    setFolder,
    category,
    setCategory,
    unreadOnly,
    setUnreadOnly,
    submitted,
    search: setSubmitted,
    searching,
    showsDrafts,
    list,
    threads,
    drafts,
    reloadDrafts: () => setDraftsGeneration((n) => n + 1),
    loadingMore,
    loadMore,
    counts,
    categoryCounts,
    loadCategoryCounts,
    contacts,
    sendAs,
    writeError,
    dismissWriteError: () => setWriteError(null),
    reportError: setWriteError,
    reader,
    openId,
    openRow,
    meeting: meeting !== null && meeting.threadId === openId ? meeting : null,
    openThread,
    closeThread,
    reloadThread,
    load,
    refresh,
    setRead,
    setStarred,
    removeThreads,
    call,
  }
}

export type MailState = ReturnType<typeof useMail>
