/**
 * Mail — search, read, triage, and link a thread into the vault.
 *
 * A list on the left, the open thread on the right. Opening marks read; a
 * thread can be starred, archived or trashed; and since D71 it can be replied
 * to, replied-all to, and forwarded without leaving. There is still no label
 * editing.
 *
 * - **Permanent delete cannot happen.** It needs `https://mail.google.com/`,
 *   which Holi does not request. Trash is Gmail's trash — recoverable for 30
 *   days — which is why the button says trash and not delete. This paragraph
 *   is the one this file keeps having to restore; the bound is the scope, and
 *   it has not moved.
 * - **Replying no longer opens Gmail.** It used to, and the note here said so
 *   because no compose surface was built — never because the scope forbade it.
 *   One is built now ([[MailComposer]]), and it mounts *inline at the foot of
 *   the thread*: when you are replying, the thing you are replying to is the
 *   context you need, and a modal hides it. A new message is a dialog, because
 *   it has no context to preserve.
 *
 * **Writes are optimistic here and nowhere below.** The list paints the change
 * immediately and restores the previous list if Google refuses, because a
 * revert costs a re-render and nothing is persisted. `main/google/data.ts`
 * takes the opposite order deliberately — see the note on `write` there.
 *
 * **Bodies are sanitized HTML in a sandboxed frame** (D67, revised). A message
 * arrives with both an `html` part and a plain-text one; HTML wins when it
 * exists, because mail is designed and a reader that flattens every newsletter
 * to text is not a reader. The two defences that make that safe, and the
 * blocking of remote content, live in [[SandboxedHtml]] — shared with the
 * agenda, whose event descriptions are third-party HTML by the same logic.
 *
 * **The chrome is one row.** There is no "Mail" heading: the tab already says
 * so, and a title bar inside a pane that is already labelled spends the
 * narrowest dimension of the narrowest panel on a word nobody reads twice.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  Link2,
  MailMinus,
  MailOpen,
  Paperclip,
  PenLine,
  Forward,
  RefreshCw,
  Reply,
  ReplyAll,
  Search,
  Star,
  Trash2,
  X,
} from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  Tooltip,
} from '@/primitives'
import { SandboxedHtml } from './SandboxedHtml'
import { MailComposer } from './MailComposer'
import type { ComposeIntent } from '../../lib/compose-intent'
import { matchHotkey } from '../../lib/hotkey'
import type {
  MailAddress,
  MailAttachment as Attachment,
  ThreadMessage,
} from '../../lib/mail-types'
import { trpc } from '../../lib/trpc'
import { activeRemoteAtom } from '../../state/vaults'
import { openNoteTabAtom } from '../../state/panes'
import { useGlobalPanelLayout } from '../../state/preferences'

/** Mirrors `main/google/gmail.ts`. */
type MailCategory = 'primary' | 'social' | 'promotions' | 'updates' | 'forums'

/**
 * `MailAddress`, `Attachment` and `ThreadMessage` used to be declared here.
 *
 * They moved to `lib/mail-types.ts` when the composer landed (D71), because
 * `compose-intent` needs the same shapes and a second copy of a mail message is
 * exactly how the `to` and `cc` fields drift apart — one file gains a field,
 * the other keeps compiling, and a reply-all quietly stops copying somebody.
 */

/**
 * Gmail's tabs, plus the default: no tab at all.
 *
 * **`null` is first and is the default, deliberately.** `category:primary`
 * matches nothing unless the account actually *uses* inbox categories, and any
 * non-Default inbox layout — Priority Inbox, Multiple Inboxes, Important-first
 * — switches them off. Defaulting to Primary emptied a real inbox
 * ("Email view says No threads"). The tabs are offered; they are not assumed.
 */
const CATEGORIES: { value: MailCategory | null; label: string }[] = [
  { value: null, label: 'All mail' },
  { value: 'primary', label: 'Primary' },
  { value: 'social', label: 'Social' },
  { value: 'promotions', label: 'Promotions' },
  { value: 'updates', label: 'Updates' },
  { value: 'forums', label: 'Forums' },
]

interface ThreadSummary {
  id: string
  subject: string
  from: MailAddress
  date: string
  snippet: string
  unread: boolean
  /** The last message is one the user sent — replied, waiting on them. */
  answered: boolean
  messageCount: number
  webUrl: string
  starred: boolean
  important: boolean
  /** An unsent draft sits in this thread. */
  hasDraft: boolean
  category: MailCategory | null
  /** User label names, already resolved in main. */
  labels: string[]
  unsubscribeUrl: string | null
}

interface Thread {
  id: string
  subject: string
  webUrl: string
  messages: ThreadMessage[]
}

/** Exact counts from Gmail's own per-label bookkeeping — never an estimate. */
interface MailCounts {
  unread: number
  total: number
}

/** Mirrors `CategoryCount` in `main/google/gmail.ts`. `more` means the answer
 *  ran past one page, so it renders as `500+` rather than as a number that
 *  quietly means "at least". */
interface CategoryCount {
  count: number
  more: boolean
}

type CategoryCounts = Partial<Record<MailCategory, CategoryCount | null>>

type ListState =
  | { kind: 'loading' }
  | {
      kind: 'ready'
      threads: ThreadSummary[]
      /** null when Gmail says there is nothing further. */
      nextPageToken: string | null
      /** When these threads were obtained from Google, ISO. */
      syncedAt: string
    }
  | { kind: 'disconnected' }
  | { kind: 'error'; message: string }

const NOT_CONNECTED = /not connected|connect Google|no longer valid|not configured/i

function shortDate(iso: string): string {
  if (iso === '') return ''
  const date = new Date(iso)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function MailView() {
  const [query, setQuery] = useState('')
  /** The query actually fetched — separate from the input, so typing does not
   *  fire a request per keystroke against a rate-limited API. */
  const [submitted, setSubmitted] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [list, setList] = useState<ListState>({ kind: 'loading' })
  const [counts, setCounts] = useState<MailCounts | null>(null)
  /** The address book, fetched once. A corpus to filter locally, not a search
   *  endpoint — completing from it must not cost a request per keystroke. */
  const [contacts, setContacts] = useState<MailAddress[]>([])
  /** Why the last triage action did not stick. Cleared on the next attempt. */
  const [writeError, setWriteError] = useState<string | null>(null)
  const [open, setOpen] = useState<Thread | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [openSummary, setOpenSummary] = useState<ThreadSummary | null>(null)
  /** Which Gmail tab the list is showing; `null` is the whole inbox, and the
   *  default — see `CATEGORIES`. */
  const [category, setCategory] = useState<MailCategory | null>(null)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  /** Unread per Gmail tab. `null` until the picker is first opened — five
   *  requests is not a price to pay for a dropdown nobody has touched. */
  const [categoryCounts, setCategoryCounts] = useState<CategoryCounts | null>(null)
  /**
   * Bumped by everything that replaces the list.
   *
   * An optimistic write captures the list it is undoing; this is how it knows,
   * on failure, whether that undo is still valid. See `write`.
   */
  const listGeneration = useRef(0)
  /** The inline composer's intent, or `null` when it is closed (D71). */
  const [composing, setComposing] = useState<ComposeIntent | null>(null)
  /**
   * Bumped on every open, so React remounts the composer rather than reusing
   * it. Without this, clicking Reply and then Forward would leave the first
   * intent's draft state in place — `composeFrom` runs once, on mount.
   */
  const [composeKey, setComposeKey] = useState(0)
  /** Every address the account may send from, so reply-all excludes all of
   *  them. `[]` until it resolves; the cost of being early is copying the user
   *  on their own reply, which they can see and remove. */
  const [sendAs, setSendAs] = useState<string[]>([])
  const remote = useAtomValue(activeRemoteAtom)
  const openNote = useSetAtom(openNoteTabAtom)
  /** Account-scoped, not per-vault: mail is the same mail in every vault, and it
   *  opens with no vault at all. See `useGlobalPanelLayout`. */
  const layout = useGlobalPanelLayout('mail')

  /**
   * The category actually sent.
   *
   * **A search escapes the tab**, exactly as Gmail's own search does. ANDing
   * the category onto an explicit query silently narrows it, and a search that
   * comes back empty for a reason the user cannot see is worse than no tabs.
   */
  const filter = submitted === '' ? (category ?? undefined) : undefined

  const load = useCallback(() => {
    setList({ kind: 'loading' })
    listGeneration.current++
    void trpc.google.threads
      .query({ query: submitted, category: filter, unread: unreadOnly || undefined })
      .then((page) =>
        setList({
          kind: 'ready',
          threads: page.threads,
          nextPageToken: page.nextPageToken,
          syncedAt: page.syncedAt,
        }),
      )
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Could not load your mail.'
        setList(NOT_CONNECTED.test(message) ? { kind: 'disconnected' } : { kind: 'error', message })
      })
  }, [submitted, filter, unreadOnly])

  useEffect(load, [load])

  /** The footer's numbers. One request, and a failure leaves the footer
   *  numberless rather than the list broken. */
  const loadCounts = useCallback(() => {
    void trpc.google.mailCounts
      .query()
      .then(setCounts)
      .catch(() => setCounts(null))
  }, [])

  useEffect(loadCounts, [loadCounts])

  /**
   * Unread per tab, **on demand**.
   *
   * Five requests, so they are not spent until the picker is actually opened —
   * and once opened, they refresh with everything else. A count that is exact
   * but two minutes old is still exact about the moment it names; a count that
   * cost five requests on every mount is not worth what it says.
   */
  const loadCategoryCounts = useCallback(() => {
    void trpc.google.categoryCounts
      .query()
      .then(setCategoryCounts)
      // The tabs still work with no numbers on them. Losing the counts must not
      // cost the picker.
      .catch(() => setCategoryCounts(null))
  }, [])

  /**
   * The address book, once per mount.
   *
   * A failure is silent and leaves `contacts` empty, which is not a degraded
   * state so much as the state this feature shipped in: completion still runs
   * off the senders in loaded threads. That is also what happens on a grant
   * that predates `contacts.readonly` — settings is where that gets said, not
   * a dropdown.
   */
  useEffect(() => {
    void trpc.google.contacts
      .query()
      .then(setContacts)
      .catch(() => setContacts([]))
  }, [])

  /**
   * The send-as aliases, for reply-all (D71).
   *
   * Failure leaves the list empty rather than blocking the view: the cost is
   * that a reply-all to a message addressed to an alias copies the user on
   * their own reply, which is visible as a chip they can remove. Refusing to
   * open the composer over it would be far worse.
   */
  useEffect(() => {
    void trpc.google.sendAs
      .query()
      .then(setSendAs)
      .catch(() => setSendAs([]))
  }, [])

  /**
   * The message a reply should answer.
   *
   * The last message the user did **not** send, falling back to the last one —
   * the same rule `replyToThread` applies in main, and for the same reason:
   * replying to your own last reply addresses the message to yourself. A thread
   * the user started and nobody answered falls back correctly.
   *
   * `SENT` is not in the renderer's `ThreadMessage`, so this compares against
   * `sendAs` instead. An empty `sendAs` degrades to "the last message", which is
   * the old behaviour rather than a wrong one.
   */
  const replyTarget = (thread: Thread): ThreadMessage | null => {
    if (thread.messages.length === 0) return null
    const mine = new Set(sendAs.map((address) => address.toLowerCase()))
    const inbound = [...thread.messages]
      .reverse()
      .find((message) => !mine.has(message.from.email.toLowerCase()))
    return inbound ?? thread.messages[thread.messages.length - 1]!
  }

  const startCompose = (all: boolean): void => {
    if (open === null) return
    const parent = replyTarget(open)
    if (parent === null) return
    setComposeKey((key) => key + 1)
    setComposing({ kind: 'reply', threadId: open.id, subject: open.subject, parent, all })
  }

  const startForward = (): void => {
    if (open === null) return
    const parent = replyTarget(open)
    if (parent === null) return
    setComposeKey((key) => key + 1)
    setComposing({ kind: 'forward', threadId: open.id, subject: open.subject, parent })
  }

  /**
   * A sent message, painted before Google is asked again.
   *
   * The file's standing rule — optimism in the renderer, never on disk. The
   * appended message carries no id from `google.send` (`id: null` is a
   * success), and it does not need one: display needs no id, and the refetch
   * below replaces it with the real thing.
   */
  const onComposerSent = (): void => {
    const intent = composing
    setComposing(null)
    if (open === null || intent === null || intent.kind === 'new') return

    void trpc.google.thread
      .query({ id: open.id })
      .then(setOpen)
      .catch(() => {
        // The send succeeded; only the refetch failed. Leaving the thread as it
        // was is right — inventing a message here would show the user a copy of
        // something we cannot confirm arrived.
      })
    load()
  }

  /**
   * The next page, **appended**.
   *
   * A button rather than an infinite scroller: Gmail is rate limited, and an
   * unbounded scroll over a rate-limited API is a bad pair — one flick of a
   * trackpad would spend a minute's quota.
   */
  const loadMore = (pageToken: string) => {
    setLoadingMore(true)
    void trpc.google.threads
      .query({ query: submitted, category: filter, unread: unreadOnly || undefined, pageToken })
      .then((page) => {
        listGeneration.current++
        setList((previous) =>
          previous.kind === 'ready'
            ? {
                kind: 'ready',
                threads: [...previous.threads, ...page.threads],
                nextPageToken: page.nextPageToken,
                syncedAt: page.syncedAt,
              }
            : previous,
        )
      })
      // A failed "load more" leaves what is already on screen alone: the list is
      // still true, it is merely shorter than it could be.
      .finally(() => setLoadingMore(false))
  }

  /**
   * Open a thread.
   *
   * The row's **summary** is kept alongside the fetched thread: the flags that
   * matter while reading — the unsubscribe link above all — come from the list
   * response, and refetching them per open would be a request for data already
   * in hand.
   */
  const openThread = (thread: ThreadSummary) => {
    setOpenId(thread.id)
    setOpenSummary(thread)
    setOpen(null)
    void trpc.google.thread
      .query({ id: thread.id })
      .then(setOpen)
      .catch(() => setOpenId(null))
    // Only when there is something to change. A request per open, for a thread
    // already read, against a rate-limited API, would spend exactly what the
    // `history.list` delta was built to save.
    if (thread.unread) void markRead(thread.id)
  }

  /**
   * A write, painted immediately and undone if Google refuses.
   *
   * **Optimism belongs here and nowhere below.** A revert costs a re-render and
   * nothing is persisted, so the list can afford to be wrong for 200ms. `main`
   * cannot: it touches the cache only once Google has agreed, because a cached
   * write Google refused is the one divergence a delta sync can never find —
   * `history.list` reports what changed *at Gmail*, and for a refused request
   * nothing did.
   *
   * The whole previous list is the undo, rather than an inverse per operation:
   * restoring a removed row means putting it back at its index, and "unarchive"
   * is not a thing this app can express.
   */
  const write = async (mutate: () => Promise<unknown>, next: (threads: ThreadSummary[]) => ThreadSummary[]) => {
    if (list.kind !== 'ready') return
    const snapshot = list.threads
    const at = ++listGeneration.current
    setWriteError(null)
    setList((previous) =>
      previous.kind === 'ready' ? { ...previous, threads: next(previous.threads) } : previous,
    )
    try {
      await mutate()
    } catch (err: unknown) {
      /**
       * The snapshot is only a valid undo while nothing else has touched the
       * list.
       *
       * Restoring it unconditionally was wrong in two reachable ways, and both
       * show up in ordinary triage: marking one thread read while the previous
       * one is still in flight, and clicking refresh straight after an archive.
       * In each case the snapshot is a list that has since moved on, and
       * writing it back discards the other change wholesale — a star that
       * vanishes from a thread Google has starred, or a fresh page replaced by
       * a stale one.
       *
       * When it has moved, the honest recovery is to re-read rather than to
       * invent an undo: `load()` asks what is actually true.
       */
      if (listGeneration.current === at) {
        setList((previous) =>
          previous.kind === 'ready' ? { ...previous, threads: snapshot } : previous,
        )
      } else {
        load()
      }
      // **A silent revert is the bug, not the recovery.** Undoing the paint
      // leaves the row exactly as it was before the click, which is
      // indistinguishable from the click never registering — and that is how a
      // grant missing `gmail.modify` presented in real use: mail loading fine,
      // triage doing nothing, no reason given anywhere.
      setWriteError(explainWriteFailure(err))
    }
  }

  const markRead = (id: string) =>
    write(
      () => trpc.google.markRead.mutate({ id }),
      (threads) => threads.map((t) => (t.id === id ? { ...t, unread: false } : t)),
    )

  const setStarred = (id: string, starred: boolean) =>
    write(
      () => trpc.google.setStarred.mutate({ id, starred }),
      (threads) => threads.map((t) => (t.id === id ? { ...t, starred } : t)),
    )

  /**
   * Archive and trash, which both take the thread out of the list.
   *
   * The reader closes with it. Leaving it open is how `openSummary` goes on
   * rendering a thread the list no longer holds — a pane describing mail that,
   * as far as every other surface is concerned, is gone.
   */
  const removeThread = (id: string, mutate: () => Promise<unknown>) => {
    if (openId === id) {
      setOpen(null)
      setOpenId(null)
      setOpenSummary(null)
    }
    return write(mutate, (threads) => threads.filter((t) => t.id !== id))
  }

  /**
   * Link the open thread into a task.
   *
   * The link is an ordinary markdown link in the task **body** (D67) — there is
   * no frontmatter field and nothing machine-owned, so "which tasks reference
   * this thread" stays a grep.
   */
  const linkToTask = async (thread: Thread) => {
    if (remote === null) return
    const { path } = await trpc.tasks.create.mutate({
      remote,
      title: thread.subject,
      folder: '',
      description: `[${thread.subject}](${thread.webUrl})\n`,
    })
    openNote(path)
  }

  const threads = list.kind === 'ready' ? list.threads : []

  /**
   * The open thread's row, as the list has it *now*.
   *
   * `openSummary` is the row as it was when the thread was opened, which was
   * enough while nothing could change it. Starring changes it, so reading the
   * flag from that snapshot would leave the button showing the state it had
   * before the click. The list is where flags move; `openSummary` remains the
   * fallback for a thread the current list does not contain — after a search,
   * or after this thread was archived out of it.
   */
  const openRow = threads.find((thread) => thread.id === openId) ?? openSummary

  /**
   * ⌘F, scoped to this pane.
   *
   * On the container rather than the document, which is what "with this pane
   * focused" actually means: a keydown only reaches here when focus is already
   * inside, so mail's ⌘F cannot fire while the user is typing in the editor.
   * The cost is that it does nothing until something in the pane has been
   * clicked — correct, and much better than a global binding that steals ⌘F
   * from every other surface in the app.
   */
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!matchHotkey(event.nativeEvent, '⌘F')) return
    event.preventDefault()
    setSearchOpen(true)
  }

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="h-full min-h-0"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
      onKeyDown={onKeyDown}
    >
      {/* The list. Was a fixed `w-80`, which is the wrong constant for both ends
          of the range this view is actually used at — a long subject truncates
          to uselessness on a wide window, and on a narrow one the list crowds
          out the message it exists to open. */}
      <ResizablePanel id="mail-list" defaultSize={320} minSize={220} maxSize={640}>
        <div className="flex h-full min-h-0 flex-col">
          <MailToolbar
            query={query}
            onQueryChange={setQuery}
            onSubmit={setSubmitted}
            searchOpen={searchOpen}
            onSearchOpenChange={setSearchOpen}
            people={threads}
            contacts={contacts}
            category={category}
            onCategoryChange={setCategory}
            searching={submitted !== ''}
            unreadOnly={unreadOnly}
            onUnreadChange={setUnreadOnly}
            unreadCount={counts?.unread ?? null}
            inboxUnread={counts?.unread ?? null}
            categoryCounts={categoryCounts}
            onCategoryMenuOpen={loadCategoryCounts}
            onRefresh={() => {
              load()
              loadCounts()
              // Only if they are on screen already — refresh must not be the
              // thing that first spends five requests on a dropdown.
              if (categoryCounts !== null) loadCategoryCounts()
            }}
          />

          {/* Above the list rather than beside the button that failed: archive
              and trash close the reader, so a message anchored there would
              vanish with the pane that raised it. */}
          {writeError !== null && (
            <div className="flex shrink-0 items-start gap-2 border-b border-border bg-secondary px-3 py-1.5 text-[11px] text-amber-400">
              <span className="min-w-0 flex-1">{writeError}</span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="dismiss"
                onClick={() => setWriteError(null)}
              >
                <X size={12} />
              </Button>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto">
            {list.kind === 'loading' && <Note>Loading…</Note>}
            {list.kind === 'disconnected' && (
              <Note>Google isn&rsquo;t connected. Connect it in vault settings.</Note>
            )}
            {list.kind === 'error' && <Note>{list.message}</Note>}
            {/* Naming the filter matters: an empty tab and an empty mailbox look
                identical otherwise, which is exactly how defaulting to Primary
                read as "my mail is gone". */}
            {list.kind === 'ready' && list.threads.length === 0 && (
              <Note>{emptyMessage(filter, unreadOnly)}</Note>
            )}
            {list.kind === 'ready' &&
              list.threads.map((thread) => (
                <ThreadRow
                  key={thread.id}
                  thread={thread}
                  active={openId === thread.id}
                  onOpen={() => openThread(thread)}
                />
              ))}
            {list.kind === 'ready' && list.nextPageToken !== null && (
              <div className="p-2">
                {/* A button, not an infinite scroller: one flick of a trackpad
                    against a rate-limited API spends a minute's quota. */}
                <Button
                  variant="secondary"
                  size="xs"
                  className="w-full"
                  disabled={loadingMore}
                  onClick={() => loadMore(list.nextPageToken!)}
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </div>

          <ListFooter
            syncing={list.kind === 'loading'}
            syncedAt={list.kind === 'ready' ? list.syncedAt : null}
            counts={counts}
            shown={threads.length}
          />
        </div>
      </ResizablePanel>

      {/* The divider IS the handle — the list's old `border-r` came off with the
          fixed width, so there is one line here rather than two. */}
      <ResizableHandle />

      {/* The reader */}
      <ResizablePanel id="mail-reader" minSize={280}>
        <div className="flex h-full min-h-0 min-w-0 flex-col">
          {openId === null ? (
            <Note>Pick a thread to read it.</Note>
          ) : open === null ? (
            <Note>Loading…</Note>
          ) : (
            <>
              <div className="flex h-11 shrink-0 items-center gap-2 px-4">
                <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{open.subject}</h3>
                <Tooltip content="make a task linking this thread">
                  <Button
                    variant="secondary"
                    size="xs"
                    className="shrink-0 gap-1"
                    disabled={remote === null}
                    onClick={() => void linkToTask(open)}
                  >
                    <Link2 size={13} />
                    Task
                  </Button>
                </Tooltip>
                {/* Advertised by the sender in List-Unsubscribe. Opened, never
                    requested: firing it silently would be a request made on the
                    user's behalf, to a URL a stranger chose. */}
                {openRow?.unsubscribeUrl != null && (
                  <Tooltip content="open this sender’s unsubscribe page">
                    <Button
                      variant="ghost"
                      size="xs"
                      className="shrink-0 gap-1"
                      aria-label="unsubscribe from this sender"
                      onClick={() => void window.holi.openExternal(openRow.unsubscribeUrl!)}
                    >
                      <MailMinus size={13} />
                      Unsubscribe
                    </Button>
                  </Tooltip>
                )}
                {/* Triage (D68). Star is a toggle that says which way it goes;
                    archive and trash both take the thread out of the list. */}
                <Tooltip content={openRow?.starred === true ? 'unstar' : 'star'}>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={
                      openRow?.starred === true ? 'unstar this thread' : 'star this thread'
                    }
                    onClick={() => void setStarred(open.id, openRow?.starred !== true)}
                  >
                    <Star
                      size={14}
                      // Filled means starred — the outline alone reads as a
                      // button rather than a state.
                      className={openRow?.starred === true ? 'fill-current' : undefined}
                    />
                  </Button>
                </Tooltip>
                <Tooltip content="archive — removes it from the inbox, keeps it in All Mail">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="archive this thread"
                    onClick={() =>
                      void removeThread(open.id, () => trpc.google.archive.mutate({ id: open.id }))
                    }
                  >
                    <Archive size={14} />
                  </Button>
                </Tooltip>
                {/* Trash, which Gmail keeps for 30 days. Deliberately not
                    called Delete: Holi cannot delete mail permanently, and a
                    button that says so would be promising something it has no
                    scope to do. */}
                <Tooltip content="move to trash — recoverable for 30 days">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="move this thread to trash"
                    onClick={() =>
                      void removeThread(open.id, () => trpc.google.trash.mutate({ id: open.id }))
                    }
                  >
                    <Trash2 size={14} />
                  </Button>
                </Tooltip>
                {/* Reply, reply-all and forward all open the same inline
                    composer below. `lastInbound` rather than the last message:
                    replying to your own last reply addresses you. */}
                <Tooltip content="reply">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="reply"
                    onClick={() => startCompose(false)}
                  >
                    <Reply size={14} />
                  </Button>
                </Tooltip>
                <Tooltip content="reply to everyone">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="reply to everyone"
                    onClick={() => startCompose(true)}
                  >
                    <ReplyAll size={14} />
                  </Button>
                </Tooltip>
                <Tooltip content="forward">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="forward"
                    onClick={startForward}
                  >
                    <Forward size={14} />
                  </Button>
                </Tooltip>
                <Tooltip content="open in Gmail">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="open in Gmail"
                    onClick={() => void window.holi.openExternal(open.webUrl)}
                  >
                    <ExternalLink size={14} />
                  </Button>
                </Tooltip>
              </div>

              {/* One scroller for the whole thread. Each message renders at its
                  full height inside it, so the thread reads as one column —
                  see `SandboxedHtml` for how a frame is sized to its content. */}
              <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8">
                {open.messages.map((message, index) => (
                  <MessageBlock
                    key={message.id}
                    message={message}
                    threadUrl={open.webUrl}
                    // The last message is the one being read; the history above
                    // it is context you open when you want it. Gmail collapses
                    // the same way, and a ten-message thread that opens fully
                    // expanded buries the part that is new.
                    initiallyOpen={index === open.messages.length - 1}
                  />
                ))}

                {/* Inline, at the foot of the thread, inside the same scroller
                    — so the message being answered stays on screen while the
                    answer is written. */}
                {composing !== null && (
                  <MailComposer
                    key={composeKey}
                    intent={composing}
                    sendAs={sendAs}
                    suggestions={contacts}
                    onSent={onComposerSent}
                    onDiscarded={() => setComposing(null)}
                    onClose={() => setComposing(null)}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

const NEEDS_SCOPE = 'Holi needs new Google permissions for this. Reconnect Google in settings.'
const NOT_CONNECTED_MESSAGE = 'Google isn’t connected. Connect it in vault settings.'
const RATE_LIMITED = 'Google is rate limiting. Try again in a moment.'

/**
 * tRPC's verdict, as `ipcLink` rebuilt it.
 *
 * `main/trpc-call.ts` puts main's code on the envelope and `ipc-link.ts` lands
 * it on `err.data.code`, which is where tRPC's own callers already look.
 */
function codeOf(err: unknown): string | null {
  const data = (err as { data?: { code?: unknown } } | null)?.data
  return typeof data?.code === 'string' ? data.code : null
}

/**
 * Why a triage action did not stick, in terms the user can act on.
 *
 * The scope case is singled out because it is both the likeliest and the only
 * one with a fix the user can perform — and because its natural symptom is
 * silence: mail loads, so the connection looks healthy, and only the writes
 * fail. "Reconnect Google in settings" is the whole message worth sending.
 *
 * **The code first, the prose second.** The router maps `GoogleApiError.code`
 * onto a tRPC code precisely so this does not have to read Google's sentences
 * (`rethrowGoogle`); matching on the message alone made the wording in
 * `google/api.ts` load-bearing UI behaviour with no test between the two. The
 * regexes stay as the fallback, because an error can still arrive from
 * somewhere that never had a code — and because "the code was lost" should
 * degrade to the old answer rather than to "that didn't stick".
 */
function explainWriteFailure(err: unknown): string {
  switch (codeOf(err)) {
    case 'FORBIDDEN':
      return NEEDS_SCOPE
    case 'UNAUTHORIZED':
    case 'PRECONDITION_FAILED':
      return NOT_CONNECTED_MESSAGE
    case 'TOO_MANY_REQUESTS':
      return RATE_LIMITED
  }

  const message = err instanceof Error ? err.message : ''
  if (/permission|scope|insufficient/i.test(message)) return NEEDS_SCOPE
  if (NOT_CONNECTED.test(message)) return NOT_CONNECTED_MESSAGE
  if (/rate limit/i.test(message)) return RATE_LIMITED
  return message === '' ? 'That didn’t stick. Try again.' : message
}

/** Why the list is empty, in the terms the user set it to be. */
function emptyMessage(filter: MailCategory | undefined, unreadOnly: boolean): string {
  if (unreadOnly && filter === undefined) return 'Nothing unread.'
  if (filter === undefined) return 'No threads.'
  const label = CATEGORIES.find((c) => c.value === filter)?.label ?? filter
  const nothing = unreadOnly ? `Nothing unread in ${label}` : `Nothing in ${label}`
  return `${nothing}. Gmail’s tabs only apply if your inbox uses them.`
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="p-6 text-center text-sm text-muted-foreground">{children}</p>
}

/**
 * The one row of chrome above the list.
 *
 * Search is an **icon until it is wanted**. A permanently-open search field in
 * a panel this narrow costs a whole row to a control that is used occasionally,
 * and the list is what the pane is for.
 */
function MailToolbar({
  query,
  onQueryChange,
  onSubmit,
  searchOpen,
  onSearchOpenChange,
  people,
  contacts,
  category,
  onCategoryChange,
  searching,
  unreadOnly,
  onUnreadChange,
  unreadCount,
  inboxUnread,
  categoryCounts,
  onCategoryMenuOpen,
  onRefresh,
}: {
  query: string
  onQueryChange: (value: string) => void
  onSubmit: (value: string) => void
  searchOpen: boolean
  onSearchOpenChange: (open: boolean) => void
  people: ThreadSummary[]
  contacts: MailAddress[]
  category: MailCategory | null
  onCategoryChange: (category: MailCategory | null) => void
  searching: boolean
  unreadOnly: boolean
  onUnreadChange: (unread: boolean) => void
  unreadCount: number | null
  inboxUnread: number | null
  categoryCounts: CategoryCounts | null
  onCategoryMenuOpen: () => void
  onRefresh: () => void
}): React.JSX.Element {
  if (searchOpen) {
    return (
      <div className="flex h-11 shrink-0 items-center gap-1 px-2">
        <SearchField
          query={query}
          onQueryChange={onQueryChange}
          contacts={contacts}
          onSubmit={onSubmit}
          people={people}
          onClose={() => {
            onQueryChange('')
            onSubmit('')
            onSearchOpenChange(false)
          }}
        />
      </div>
    )
  }

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 px-2">
      <Tooltip content="search mail (⌘F)">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="search mail"
          onClick={() => onSearchOpenChange(true)}
        >
          <Search size={14} />
        </Button>
      </Tooltip>

      {/* A state, not a place — so unlike the category tabs it survives a
          search, and it is a toggle rather than an entry in the picker. */}
      <Tooltip content={unreadOnly ? 'showing unread only' : 'show unread only'}>
        <Button
          variant={unreadOnly ? 'secondary' : 'ghost'}
          size="xs"
          className="gap-1"
          aria-label="show unread only"
          aria-pressed={unreadOnly}
          onClick={() => onUnreadChange(!unreadOnly)}
        >
          <MailOpen size={14} />
          {unreadCount !== null && unreadCount > 0 && (
            <span className="text-[10px] text-muted-foreground">{unreadCount}</span>
          )}
        </Button>
      </Tooltip>

      {/* Gone during a search, as Gmail's own tabs are: a picker reading
          "Promotions" over unfiltered results claims a filter that is not
          applied. Clearing the search brings it back. */}
      {!searching && (
        <CategoryPicker
          category={category}
          onChange={onCategoryChange}
          counts={categoryCounts}
          inboxUnread={inboxUnread}
          onOpen={onCategoryMenuOpen}
        />
      )}

      <Tooltip content="refresh">
        <Button
          variant="ghost"
          size="icon-xs"
          className={searching ? '' : 'ml-auto'}
          aria-label="refresh mail"
          onClick={onRefresh}
        >
          <RefreshCw size={14} />
        </Button>
      </Tooltip>
    </div>
  )
}

/**
 * The unfolded search box, with people completion on `@`.
 *
 * Enter submits. No `<form>` — the gate keeps native elements inside
 * `primitives/`, and a search box needs nothing a form would add.
 */
function SearchField({
  query,
  onQueryChange,
  onSubmit,
  people,
  contacts,
  onClose,
}: {
  query: string
  onQueryChange: (value: string) => void
  onSubmit: (value: string) => void
  people: ThreadSummary[]
  contacts: MailAddress[]
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  const [highlighted, setHighlighted] = useState(0)

  // Unfolding a search field that is not focused would be a control that looks
  // ready and is not — the click that opened it is the same gesture as the
  // intent to type.
  useEffect(() => ref.current?.focus(), [])

  const mention = mentionAt(query)
  const matches = useMemo(
    () => (mention === null ? [] : matchPeople(people, mention.term, contacts)),
    [people, contacts, mention],
  )
  useEffect(() => setHighlighted(0), [mention?.term])

  const accept = (person: Person) => {
    const next = replaceMention(query, mention!, person.email)
    onQueryChange(next)
    ref.current?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (matches.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlighted((i) => (i + 1) % matches.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlighted((i) => (i - 1 + matches.length) % matches.length)
        return
      }
      // Enter completes the mention rather than running the search: a half-typed
      // address is never the query the user meant to submit.
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        accept(matches[highlighted]!)
        return
      }
    }
    if (event.key === 'Enter') onSubmit(query)
    if (event.key === 'Escape') onClose()
  }

  return (
    <div className="relative flex min-w-0 flex-1 items-center gap-1">
      <Search size={14} className="shrink-0 text-muted-foreground" />
      <Input
        ref={ref}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Gmail syntax — @ for people"
        className="h-7 text-xs"
        aria-label="search mail"
        role="combobox"
        aria-expanded={matches.length > 0}
        aria-controls="mail-people"
      />
      <Tooltip content="close search">
        <Button variant="ghost" size="icon-xs" aria-label="close search" onClick={onClose}>
          <X size={14} />
        </Button>
      </Tooltip>

      {matches.length > 0 && (
        <ul
          id="mail-people"
          role="listbox"
          className="absolute top-8 right-0 left-0 z-20 max-h-56 overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-md"
        >
          {matches.map((person, index) => (
            // The button IS the option, not a child of one: the thing that is
            // clicked and the thing that is announced have to be the same
            // element, or a pointer lands on a row that carries no handler.
            <li key={person.email} role="presentation">
              <Button
                variant="ghost"
                role="option"
                aria-selected={index === highlighted}
                className={`block h-auto w-full rounded-none px-2 py-1 text-left ${
                  index === highlighted ? 'bg-secondary' : ''
                }`}
                // Mouse down, not click: a click fires after the input has
                // already lost focus, and the list would be gone by then.
                onMouseDown={(e) => {
                  e.preventDefault()
                  accept(person)
                }}
              >
                <span className="block truncate text-xs">{person.name}</span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {person.email} · {person.count} {person.count === 1 ? 'thread' : 'threads'}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Someone who appears in the mail already loaded. */
interface Person extends MailAddress {
  /** How many threads in hand they sent. The ranking — who you actually hear
   *  from beats who is alphabetically first. */
  count: number
}

/** Where an `@` mention starts and what has been typed since. */
interface Mention {
  start: number
  term: string
}

/**
 * The `@…` the caret is inside, if any.
 *
 * Two conditions, and the second is the one that is easy to get wrong. The `@`
 * must **start a word** — preceded by nothing, by whitespace, or by the `:` of
 * a `from:`/`to:` the user has already typed. Testing the text *after* the `@`
 * for another `@` does not work, because the last `@` never has one after it:
 * the address the user just accepted (`from:jane@syv.ai`) would reopen the list
 * on its own separator and the popup would come straight back.
 *
 * And nothing since the `@` may be whitespace — an `@` in prose is not a
 * request for a person.
 */
export function mentionAt(query: string): Mention | null {
  const at = query.lastIndexOf('@')
  if (at === -1) return null
  const before = query[at - 1]
  if (before !== undefined && !/[\s:]/.test(before)) return null
  const term = query.slice(at + 1)
  if (/\s/.test(term)) return null
  return { start: at, term }
}

/** The completed query — Gmail's own `from:` grammar, so what the box holds
 *  afterwards is a query the user could have typed and can still edit. */
export function replaceMention(query: string, mention: Mention, email: string): string {
  const before = query.slice(0, mention.start)
  // `@` is dropped, not kept: `from:@jane@x.ai` is not valid Gmail grammar, and
  // the mention was only ever a way of asking for the list.
  return `${before}${before.endsWith('from:') || before.endsWith('to:') ? '' : 'from:'}${email} `
}

/**
 * People to complete from — **two sources, ranked by evidence** (D68).
 *
 * 1. Senders across the threads in hand, counted. Who you actually hear from is
 *    the strongest signal there is, and it needs no request at all.
 * 2. The real address book, from the People API (`contacts.readonly`). Broader,
 *    and it reaches people who have not written to you recently — but with no
 *    frequency to rank on, so it sits behind.
 *
 * The local corpus is deliberately **not** replaced by contacts. It is what
 * keeps completion working when the contacts request is cold, refused, or the
 * grant predates the scope — and in the common case it is the better answer.
 */
export function matchPeople(
  threads: { from: MailAddress }[],
  term: string,
  contacts: MailAddress[] = [],
): Person[] {
  const byEmail = new Map<string, Person>()
  for (const { from } of threads) {
    if (from.email === '') continue
    const existing = byEmail.get(from.email)
    if (existing === undefined) byEmail.set(from.email, { ...from, count: 1 })
    else existing.count++
  }
  // `count: 0` is what puts the address book below everyone who has actually
  // written, and it is why this loop runs second: a contact already seen as a
  // sender keeps its count rather than being flattened to zero.
  for (const contact of contacts) {
    if (contact.email === '' || byEmail.has(contact.email)) continue
    byEmail.set(contact.email, { ...contact, count: 0 })
  }

  const needle = term.toLowerCase()
  return [...byEmail.values()]
    .filter(
      (p) => needle === '' || p.email.includes(needle) || p.name.toLowerCase().includes(needle),
    )
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 8)
}

/**
 * Sync state and how much mail there is, pinned to the bottom of the list.
 *
 * The counts are **exact** — Gmail's per-label bookkeeping, not the
 * `resultSizeEstimate` the category picker refuses to show. That refusal still
 * stands and this does not contradict it: an estimate presented as a count is a
 * number people trust and it is wrong, whereas these are the same numbers Gmail
 * shows itself. When the request fails there is simply no number.
 */
function ListFooter({
  syncing,
  syncedAt,
  counts,
  shown,
}: {
  syncing: boolean
  syncedAt: string | null
  counts: MailCounts | null
  shown: number
}): React.JSX.Element {
  return (
    <div className="flex h-7 shrink-0 items-center justify-between gap-2 border-t border-border px-2 text-[10px] text-muted-foreground">
      <span className="flex min-w-0 items-center gap-1 truncate">
        <RefreshCw size={10} className={`shrink-0 ${syncing ? 'animate-spin' : ''}`} />
        {syncing ? 'Syncing…' : syncedAt === null ? 'Not synced' : `Synced ${ago(syncedAt)}`}
      </span>
      <span className="shrink-0">
        {counts === null
          ? // Says what it actually knows. "0 unread" would be a claim; this is
            // a count of what is on screen, which is never wrong.
            `${shown} shown`
          : `${counts.unread} unread · ${counts.total} in inbox`}
      </span>
    </div>
  )
}

/** Coarse on purpose: a footer that ticks every second is motion in the corner
 *  of the eye, and nobody needs mail sync time to the second. */
function ago(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

/** One thread in the list. */
function ThreadRow({
  thread,
  active,
  onOpen,
}: {
  thread: ThreadSummary
  active: boolean
  onOpen: () => void
}): React.JSX.Element {
  return (
    <Button
      variant="ghost"
      onClick={onOpen}
      className={`block h-auto w-full rounded-none border-b border-border/50 px-3 py-2 text-left ${
        active ? 'bg-secondary' : ''
      }`}
    >
      <span className="flex items-baseline justify-between gap-2">
        {/* Weight alone was too quiet to scan — an explicit dot is what makes
            unread readable at a glance, and it holds the row's left edge so
            read and unread stay aligned. */}
        <span
          aria-hidden
          className={`mt-1 size-1.5 shrink-0 self-start rounded-full ${
            thread.unread ? 'bg-primary' : 'bg-transparent'
          }`}
        />
        <span
          className={`min-w-0 flex-1 truncate text-xs ${
            thread.unread ? 'font-semibold text-foreground' : 'text-muted-foreground'
          }`}
        >
          {thread.from.name}
          {thread.messageCount > 1 && (
            <span className="ml-1 text-muted-foreground">({thread.messageCount})</span>
          )}
        </span>
        {thread.starred && (
          <Star size={11} className="shrink-0 self-center text-muted-foreground" aria-label="starred" />
        )}
        {/* "You started replying and stopped" — a third state, distinct from
            both answered and untouched, and the only trace of it in the list. */}
        {thread.hasDraft && (
          <PenLine size={11} className="shrink-0 self-center text-muted-foreground" aria-label="unsent draft" />
        )}
        {/* "You replied and are waiting on them" — see `answered` in
            main/google/gmail.ts for why it is the LAST message that decides. */}
        {thread.answered && (
          <Reply size={11} className="shrink-0 self-center text-muted-foreground" aria-label="you replied" />
        )}
        <span className="shrink-0 text-[10px] text-muted-foreground">{shortDate(thread.date)}</span>
      </span>
      <span className={`block truncate pl-3.5 text-xs ${thread.unread ? 'font-medium' : ''}`}>
        {thread.subject}
      </span>
      <span className="block truncate pl-3.5 text-[11px] text-muted-foreground">
        {thread.snippet}
      </span>
      {thread.labels.length > 0 && (
        <span className="mt-1 flex flex-wrap gap-1 pl-3.5">
          {thread.labels.map((label) => (
            <span
              key={label}
              className="rounded bg-secondary px-1 py-px text-[10px] text-muted-foreground"
            >
              {label}
            </span>
          ))}
        </span>
      )}
    </Button>
  )
}

/**
 * Which Gmail tab the list is showing, and how much unread sits in each.
 *
 * **The counts are counted, not estimated**, which is the condition on which
 * they exist at all: this used to show none, because the obvious source is
 * `resultSizeEstimate` and an estimate presented as a count is a number people
 * trust and it is wrong. `fetchCategoryUnread` lists the tab's unread thread
 * ids in the inbox and counts them — exact, correctly scoped, and honest past
 * one page (`500+`). Read the note there for why `labels.get`, which is one
 * request instead of five, is nevertheless the wrong source.
 *
 * They are also **not fetched until this is opened**. Five requests for a
 * dropdown nobody touched is exactly the kind of cost the mail cache exists to
 * avoid paying.
 *
 * Unread rather than total, because that is what a tab badge means: "is there
 * anything in here for me" is the question, and "how much promotional mail do
 * I own" is not.
 */
function CategoryPicker({
  category,
  onChange,
  counts,
  inboxUnread,
  onOpen,
}: {
  category: MailCategory | null
  onChange: (category: MailCategory | null) => void
  counts: CategoryCounts | null
  /** The whole inbox's unread, which is what "All mail" means here. Already in
   *  hand from `mailCounts`, so it costs nothing. */
  inboxUnread: number | null
  onOpen: () => void
}) {
  const current = CATEGORIES.find((c) => c.value === category)
  return (
    <DropdownMenu onOpenChange={(open) => open && onOpen()}>
      <Tooltip content="Gmail’s tabs — only useful if your inbox uses them">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="xs" className="ml-auto" aria-label="choose a category">
            {current?.label ?? 'All mail'}
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="end">
        {CATEGORIES.map((option) => (
          <DropdownMenuItem key={option.value ?? 'all'} onSelect={() => onChange(option.value)}>
            <span className="flex w-full items-baseline justify-between gap-4">
              <span>{option.label}</span>
              {/* Nothing at all rather than a zero while the counts are in
                  flight, or when one tab's request failed: an absent number
                  says "not known", and `0` would say "nothing here". */}
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {unreadLabel(option.value, counts, inboxUnread)}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The number beside one tab, or `''` when there is nothing truthful to put
 *  there. `0` is rendered — "nothing unread" is a real answer, and a blank
 *  would read as "still loading". */
function unreadLabel(
  value: MailCategory | null,
  counts: CategoryCounts | null,
  inboxUnread: number | null,
): string {
  if (value === null) return inboxUnread === null ? '' : String(inboxUnread)
  const count = counts?.[value]
  if (count === undefined || count === null) return ''
  return count.more ? `${count.count}+` : String(count.count)
}

/**
 * One message in a thread, collapsible.
 *
 * Collapsed shows the line a reader scans for — who, when, and the first of
 * what they said. Expanding is what costs a frame, so a long thread only builds
 * the documents it is actually showing.
 */
function MessageBlock({
  message,
  threadUrl,
  initiallyOpen,
}: {
  message: ThreadMessage
  threadUrl: string
  initiallyOpen: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(initiallyOpen)

  return (
    <article className="border-b border-border/50 py-2 last:border-0">
      {/* The header is the toggle. A separate chevron button would put two
          targets on a row whose whole area already means one thing. */}
      <Button
        variant="ghost"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'collapse' : 'expand'} message from ${message.from.name}`}
        className="block h-auto w-full rounded px-1 py-1 text-left"
      >
        <span className="flex items-baseline gap-2 text-xs">
          {expanded ? (
            <ChevronDown size={12} className="shrink-0 self-center text-muted-foreground" />
          ) : (
            <ChevronRight size={12} className="shrink-0 self-center text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate font-medium">{message.from.name}</span>
          <span className="shrink-0 text-muted-foreground">{shortDate(message.date)}</span>
        </span>
        {!expanded && (
          <span className="block truncate pl-5 text-[11px] text-muted-foreground">
            {message.body.slice(0, 200)}
          </span>
        )}
      </Button>

      {expanded && (
        <div className="pl-1">
          <p className="mb-2 flex flex-wrap items-baseline gap-x-1 text-[11px] text-muted-foreground">
            <AddressLink address={message.from} />
            {message.to.length > 0 && <span>to</span>}
            <AddressList addresses={message.to} />
            {message.cc.length > 0 && <span>· cc</span>}
            <AddressList addresses={message.cc} />
          </p>
          <MessageBody message={message} />
          <Attachments attachments={message.attachments} webUrl={threadUrl} />
        </div>
      )}
    </article>
  )
}

function AddressList({ addresses }: { addresses: MailAddress[] }): React.JSX.Element {
  return (
    <>
      {addresses.map((address, index) => (
        <span key={`${address.email}:${index}`}>
          <AddressLink address={address} />
          {index < addresses.length - 1 && ','}
        </span>
      ))}
    </>
  )
}

/**
 * A person, as a thing you can act on.
 *
 * The popover is what Holi actually knows — name and address — rather than a
 * profile it would have to invent. There is no contacts scope and no avatar to
 * fetch, so the honest card is a small one, and its job is to turn the display
 * name a list shows back into the address it stands for.
 *
 * Composing is a **`mailto:` handoff**, consistent with everything else here:
 * the granted scope is read-only, so the OS's mail client sends, not Holi.
 */
function AddressLink({ address }: { address: MailAddress }): React.JSX.Element {
  // Nothing that looks like an address — a `From` this parser could not read.
  // Shown, but not offered as something to click.
  if (address.email === '') return <span className="font-medium">{address.name}</span>

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="h-auto px-1 py-0 text-[11px] font-medium"
          aria-label={`about ${address.name}`}
        >
          {address.name}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <p className="text-sm font-medium">{address.name}</p>
        <p className="mt-0.5 text-xs break-all text-muted-foreground">{address.email}</p>
        <div className="mt-3 flex gap-1">
          <Button
            variant="secondary"
            size="xs"
            className="gap-1"
            onClick={() => void window.holi.openExternal(`mailto:${address.email}`)}
          >
            <Reply size={12} />
            Email
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void navigator.clipboard.writeText(address.email)}
          >
            Copy address
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * What came with a message.
 *
 * Every one **opens the thread in Gmail** rather than downloading. The granted
 * scope is read-only and v1 does not fetch attachment bytes at all, so the
 * honest affordance is the place the file actually is — a download button that
 * cannot download would be the worst of the options.
 */
function Attachments({ attachments, webUrl }: { attachments: Attachment[]; webUrl: string }) {
  if (attachments.length === 0) return null
  return (
    <ul className="mt-2 flex flex-wrap gap-1">
      {attachments.map((attachment) => (
        <li key={attachment.filename}>
          <Tooltip content="open in Gmail — Holi does not download attachments">
            <Button
              variant="secondary"
              size="xs"
              className="gap-1"
              onClick={() => void window.holi.openExternal(webUrl)}
            >
              {attachment.mimeType.startsWith('image/') ? (
                <Paperclip size={12} />
              ) : (
                <FileText size={12} />
              )}
              <span className="max-w-48 truncate">{attachment.filename}</span>
              <span className="text-muted-foreground">{fileSize(attachment.size)}</span>
            </Button>
          </Tooltip>
        </li>
      ))}
    </ul>
  )
}

/** Bytes as a person reads them. One decimal below 10 units, none above —
 *  "1.4 MB" is useful, "1.42 MB" is noise on a chip. */
function fileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/**
 * One message's body: a sandboxed frame when there is HTML, text otherwise.
 *
 * "Load images" is per message rather than per thread, which matches how the
 * decision is actually made — a user trusts *this* newsletter, not everything
 * the thread ever collected. `SandboxedHtml` holds that, and the frame, because
 * a calendar event description is the same problem with a different sender.
 */
function MessageBody({ message }: { message: ThreadMessage }) {
  if (message.html === null) {
    return <p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>
  }
  return (
    <SandboxedHtml
      html={message.html}
      label={`message from ${message.from.name}`}
      // The message id is what makes "load images" survive the reader closing;
      // the sender is what makes "always from this sender" possible at all.
      identity={{ key: message.id, sender: message.from.email }}
    />
  )
}
