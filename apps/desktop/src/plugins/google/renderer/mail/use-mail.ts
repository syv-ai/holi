/**
 * The mail view's state and every Gmail call it makes, through Google's
 * capabilities at the UI door (`googleCap`), for the open vault.
 *
 * The rules are the ones `MailView` follows (docs/features/google.md): writes
 * paint first and revert on refusal, archive and trash raise one toast with
 * Undo, a search escapes the place it was started from, and "unread only" is a
 * state that survives it. Nothing here touches main beyond those calls.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAtomValue } from 'jotai'
import { activeRemoteAtom } from '@/plugin-api'
import { googleCap } from '../google-cap'
import { useMailMarkers } from '../use-mail-markers'
import { useMailMarkerActions } from '../use-mail-marker-actions'
import { explainWriteFailure, messageOf } from '../google-errors'
import type { MailAddress, ThreadMessage } from '../mail-types'
import type { MailFolder } from './data'
import { useMailList } from './use-mail-list'

/** Gmail's own shapes, as the capabilities return them. */
type SearchPage = Awaited<ReturnType<typeof googleCap.search>>
export type ThreadSummary = SearchPage['threads'][number]
export type Thread = Awaited<ReturnType<typeof googleCap.thread>>
export type DraftSummary = Awaited<ReturnType<typeof googleCap.drafts>>[number]
export type MailCategory = NonNullable<
  NonNullable<Parameters<typeof googleCap.search>[1]>['category']
>
export type ThreadMeeting = NonNullable<Awaited<ReturnType<typeof googleCap.meeting>>>
export type { MailAddress }

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
export function useMail(account: string | null, enabled = true) {
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
  const [drafts, setDrafts] = useState<DraftsState>({ kind: 'loading' })
  const [draftsGeneration, setDraftsGeneration] = useState(0)
  const [contacts, setContacts] = useState<MailAddress[]>([])
  const [sendAs, setSendAs] = useState<string[]>([])
  const [reader, setReader] = useState<ReaderState>({ kind: 'idle' })
  const [openSummary, setOpenSummary] = useState<ThreadSummary | null>(null)
  /** Keyed by the thread it was asked about, so a late answer never gives the
   *  next thread the previous one's Join button. */
  const [meeting, setMeeting] = useState<(ThreadMeeting & { threadId: string }) | null>(null)
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

  const mailList = useMailList({
    remote,
    account,
    visible: enabled,
    drafts: showsDrafts,
    supported: !searching && !showsDrafts,
    params,
  })
  const {
    list,
    loadingMore,
    counts,
    categoryCounts,
    load,
    loadMore,
    write,
    writeError,
    loadCategoryCounts,
    reportError: setWriteError,
  } = mailList

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
    load()
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
    const done = await Promise.allSettled(
      ids.map((id) =>
        write(
          () => call((r) => googleCap[kind](r, { id })),
          (threads) => threads.filter((t) => t.id !== id),
        ),
      ),
    )
    const moved = ids.filter((_, index) => done[index]?.status === 'fulfilled' && done[index].value)
    if (moved.length === 0) return
    mailList.offerRemovalUndo(kind, moved, (id) => {
      const inverse = kind === 'archive' ? googleCap.unarchive : googleCap.untrash
      return call((r) => inverse(r, { id }))
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
  const markers = useMailMarkers({
    remote,
    accountSub: account,
    ids: [...threads.map((thread) => thread.id), ...(openId === null ? [] : [openId])],
  })
  const markerActions = useMailMarkerActions({
    scope: JSON.stringify([folder, category, unreadOnly, submitted]),
    enabled,
    remote,
    accountSub: account,
    activeThreadId: openId,
    reconcile: (id) => markers.invalidate([id]),
    onFailure: (cause) => setWriteError(explainWriteFailure(cause)),
    runMutation: (mutate) => mailList.write(mutate),
    onChange: (id, state) => mailList.markerChanged(id, state.starred),
  })

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
    refresh: () => {
      refresh()
      markers.invalidate()
    },
    setRead,
    setStarred: async (id: string, starred: boolean) => {
      markerActions.invalidate(id)
      const result = await setStarred(id, starred)
      markers.invalidate([id])
      return result
    },
    activateMarker: (id: string, starred: boolean) => {
      const status = markers.get(id)
      markerActions.activate(id, starred, status.kind === 'ready' ? status.marker : null)
    },
    markerActions,
    retryMarker: (id: string) => markerActions.retry(id),
    markers,
    removeThreads,
    call,
  }
}

export type MailState = ReturnType<typeof useMail>
