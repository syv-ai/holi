/**
 * Mail: search, read, triage, and link a thread into the vault.
 *
 * - **Permanent delete cannot happen.** It needs `https://mail.google.com/`,
 *   which Holi does not request. Trash is Gmail's trash, recoverable for 30
 *   days, which is why the button says trash and not delete.
 * - Reply, reply-all and forward use [[MailComposer]] mounted inline at
 *   the foot of the thread, because the message being answered is the context
 *   and a modal hides it. A new message is a dialog: it has no context.
 *
 * **Writes are optimistic here and nowhere below.** The list paints the change
 * immediately and restores the previous list if Google refuses. `main/google/data.ts`
 * takes the opposite order deliberately: see the note on `write` there.
 *
 * **Bodies are sanitized HTML in a sandboxed frame**. HTML wins over the
 * plain-text part when it exists. The defences and the blocking of remote
 * content live in [[SandboxedHtml]], shared with the agenda.
 *
 * **The chrome is one row.** No "Mail" heading: the tab already says so.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
/**
 * `SquarePen` writes something new; `FilePen` continues something half-written.
 * `FilePen` is used for every draft marker (the row chip, the reader's continue
 * button, and the Drafts list), so the three agree.
 */
import {
  Archive,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FilePen,
  FileText,
  Forward,
  Link2,
  MailMinus,
  MailOpen,
  Paperclip,
  RefreshCw,
  Reply,
  ReplyAll,
  Search,
  Sparkles,
  SquarePen,
  Star,
  Trash2,
  Video,
  X,
} from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import { defaultAgentTargetAtom } from '@/state/agent'
import { sendToAgentAtom } from '@/state/agent-send'
import { buildSummarizePrompt } from '@/lib/summarize-prompt'
import {
  Button,
  Checkbox,
  Icon,
  IconButton,
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
import { DraftsList, type DraftSummary } from './DraftsList'
import { ThreadMenu, type ThreadActions } from './ThreadMenu'
import { SelectionBar } from './SelectionBar'
import { MESSAGE_BODY_ATTR, ThreadFind } from './ThreadFind'
import {
  CATEGORIES,
  MailboxPicker,
  categoryLabelOf,
  type CategoryCounts,
  type MailCategory,
  type MailboxView,
} from './MailboxPicker'
import type { ComposeIntent } from '../../lib/compose-intent'
import { matchHotkey } from '../../lib/hotkey'
import { listStamp, messageStamp } from '../../lib/mail-stamp'
import type { MailAddress, MailAttachment as Attachment, ThreadMessage } from '../../lib/mail-types'
import { trpc } from '../../lib/trpc'
import { activeRemoteAtom } from '../../state/vaults'
import { openNoteTabAtom } from '../../state/panes'
import { openDialogAtom } from '../../state/dialogs'
import { useGlobalPanelLayout } from '../../state/preferences'

interface ThreadSummary {
  id: string
  subject: string
  from: MailAddress
  date: string
  snippet: string
  unread: boolean
  /** The last message is one the user sent: replied, waiting on them. */
  answered: boolean
  messageCount: number
  webUrl: string
  starred: boolean
  important: boolean
  /** An unsent draft sits in this thread. */
  hasDraft: boolean
  category: MailCategory | null
  /** A calendar invite is attached somewhere in the thread. Resolved in main by
   *  one scoped query, not by inflating the summary fetch. See `fetchInviteIds`. */
  hasInvite: boolean
  /** User label names, already resolved in main. */
  labels: string[]
  unsubscribeUrl: string | null
}

/**
 * The meeting a thread turned out to be about. Mirrors `ThreadMeeting` in
 * `main/google/invite.ts`.
 *
 * `conferenceUrl` is null for a meeting with no video call; the whole value
 * being null means there is no such meeting on the calendar.
 */
interface ThreadMeeting {
  eventId: string
  title: string
  start: string
  end: string
  conferenceUrl: string | null
  htmlLink: string
}

interface Thread {
  id: string
  subject: string
  webUrl: string
  messages: ThreadMessage[]
}

/** Exact counts from Gmail's own per-label bookkeeping, never an estimate. */
interface MailCounts {
  unread: number
  total: number
}

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

export function MailView() {
  const [query, setQuery] = useState('')
  /** The query actually fetched, separate from the input so typing does not
   *  fire a request per keystroke against a rate-limited API. */
  const [submitted, setSubmitted] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  /** The find bar over the OPEN THREAD, a different search from the list's,
   *  which queries Gmail. See `onKeyDown` for how ⌘F chooses between them. */
  const [findOpen, setFindOpen] = useState(false)
  /** The thread's scroller. What actually moves when find steps to a match: the
   *  match itself is inside a frame that never scrolls. */
  const readerRef = useRef<HTMLDivElement>(null)
  const [list, setList] = useState<ListState>({ kind: 'loading' })
  const [counts, setCounts] = useState<MailCounts | null>(null)
  /** The address book, fetched once and filtered locally, so completing from it
   *  does not cost a request per keystroke. */
  const [contacts, setContacts] = useState<MailAddress[]>([])
  /** Why the last triage action did not stick. Cleared on the next attempt. */
  const [writeError, setWriteError] = useState<string | null>(null)
  const [open, setOpen] = useState<Thread | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [openSummary, setOpenSummary] = useState<ThreadSummary | null>(null)
  /**
   * The meeting the open thread is about, once main has matched its invite to a
   * calendar event. Null until then, and for every thread that is not a meeting.
   *
   * **Keyed by the thread it was asked about.** The answer can land after the
   * reader has moved on; without the key the next thread would inherit the
   * previous one's Join button.
   */
  const [meeting, setMeeting] = useState<(ThreadMeeting & { threadId: string }) | null>(null)
  /**
   * Where the list is pointed: a tab, Sent, or Drafts. One union so that
   * impossible places like "Drafts, filtered to Promotions" cannot be expressed.
   * `All mail` is the default: see `CATEGORIES` in [[MailboxPicker]] for why
   * not Primary.
   */
  const [view, setView] = useState<MailboxView>({ kind: 'category', category: null })
  const [unreadOnly, setUnreadOnly] = useState(false)
  /** Thread ids picked for a bulk action. Empty means the toolbar is showing. */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  /** Where the last toggle happened, so shift-click has something to extend
   *  FROM. `null` before anything has been picked, when a shift-click can only
   *  mean "select this one". */
  const [anchor, setAnchor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  /** Unread per Gmail tab. `null` until the picker is first opened: five
   *  requests is too much for a dropdown nobody has touched. */
  const [categoryCounts, setCategoryCounts] = useState<CategoryCounts | null>(null)
  /**
   * Bumped by everything that replaces the list, so a failed optimistic write
   * knows whether its undo is still valid. See `write`.
   */
  const listGeneration = useRef(0)
  /** The inline composer's intent, or `null` when it is closed. */
  const [composing, setComposing] = useState<ComposeIntent | null>(null)
  /**
   * Bumped on every open, so React remounts the composer rather than reusing
   * it: `composeFrom` runs once, on mount, so Reply then Forward would keep the
   * first intent's draft state.
   */
  const [composeKey, setComposeKey] = useState(0)
  /** Every address the account may send from, so reply-all excludes all of
   *  them. `[]` until it resolves; the cost of being early is copying the user
   *  on their own reply, which they can see and remove. */
  const [sendAs, setSendAs] = useState<string[]>([])
  /** Bumped after a save or a discard, so the Drafts list refetches. */
  const [draftsGeneration, setDraftsGeneration] = useState(0)
  /** The Gmail draft the composer is continuing, if any. */
  const [continuing, setContinuing] = useState<string | undefined>(undefined)
  const remote = useAtomValue(activeRemoteAtom)
  const openNote = useSetAtom(openNoteTabAtom)
  const openDialog = useSetAtom(openDialogAtom)
  const sendToAgent = useSetAtom(sendToAgentAtom)
  const agentTarget = useAtomValue(defaultAgentTargetAtom)
  /** Account-scoped, not per-vault: mail is the same mail in every vault, and it
   *  opens with no vault at all. See `useGlobalPanelLayout`. */
  const layout = useGlobalPanelLayout('mail')

  /**
   * Hand the open thread to the agent.
   *
   * The target was chosen at render, and the session can end before the click,
   * so a refusal falls back to a new session rather than a click that does
   * nothing.
   */
  const summarize = async () => {
    if (open === null) return
    const text = buildSummarizePrompt({
      subject: open.subject,
      threadId: open.id,
      webUrl: open.webUrl,
    })
    const res = await sendToAgent({ text, target: agentTarget })
    if (!res.ok && agentTarget !== 'new') await sendToAgent({ text, target: 'new' })
  }

  const showDrafts = view.kind === 'drafts'
  const searching = submitted !== ''

  /**
   * What actually narrows the request.
   *
   * **A search escapes the place it was started from**, tab and mailbox alike,
   * as Gmail's own search does. ANDing either onto a query silently narrows it.
   *
   * `unread` is a *state*, not a place, so it survives a search. It is dropped
   * for Sent and Drafts, where it does not apply.
   */
  const filter = searching || view.kind !== 'category' ? undefined : (view.category ?? undefined)
  const mailbox = searching || view.kind !== 'sent' ? undefined : ('sent' as const)
  const unreadFilter = view.kind === 'category' && unreadOnly ? true : undefined

  const load = useCallback(() => {
    setList({ kind: 'loading' })
    listGeneration.current++
    void trpc.google.threads
      .query({ query: submitted, category: filter, unread: unreadFilter, mailbox })
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
  }, [submitted, filter, unreadFilter, mailbox])

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
   * Unread per tab, **on demand**: five requests, not spent until the picker is
   * first opened. Once opened, they refresh with everything else.
   */
  const loadCategoryCounts = useCallback(() => {
    void trpc.google.categoryCounts
      .query()
      .then(setCategoryCounts)
      // The tabs still work with no numbers on them.
      .catch(() => setCategoryCounts(null))
  }, [])

  /**
   * The address book, once per mount.
   *
   * A failure is silent and leaves `contacts` empty: completion still runs off
   * the senders in loaded threads. That also covers a grant without
   * `contacts.readonly`, which settings reports, not a dropdown.
   */
  useEffect(() => {
    void trpc.google.contacts
      .query()
      .then(setContacts)
      .catch(() => setContacts([]))
  }, [])

  /**
   * The send-as aliases, for reply-all.
   *
   * Failure leaves the list empty rather than blocking the view: the cost is
   * that a reply-all may copy the user on their own reply, as a chip they can
   * remove.
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
   * The last message the user did **not** send, falling back to the last one:
   * the same rule `replyToThread` applies in main, because replying to your own
   * last reply addresses the message to yourself.
   *
   * `SENT` is not in the renderer's `ThreadMessage`, so this compares against
   * `sendAs` instead. An empty `sendAs` degrades to "the last message".
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
    setContinuing(undefined)
    setComposing({ kind: 'reply', threadId: open.id, subject: open.subject, parent, all })
  }

  /**
   * Continue a draft from the Drafts list.
   *
   * The intent is `new` even for a draft that belongs to a thread: the composer
   * loads recipients, subject, body and thread from `google.draft`, and an
   * intent that also computed them would flicker when overwritten.
   */
  const continueDraft = (draft: DraftSummary): void => {
    setComposeKey((key) => key + 1)
    setContinuing(draft.draftId)
    setComposing({ kind: 'new' })
    // The draft composer renders in the reader pane only with nothing open.
    // With a thread open it would land off-screen at the foot of that thread.
    setOpenId(null)
  }

  const startForward = (): void => {
    if (open === null) return
    const parent = replyTarget(open)
    if (parent === null) return
    setComposeKey((key) => key + 1)
    setContinuing(undefined)
    setComposing({ kind: 'forward', threadId: open.id, subject: open.subject, parent })
  }

  /**
   * Open the newest draft filed in the open thread.
   *
   * Asked of `google.drafts` rather than tracked: the draft may have been
   * written in Gmail or by the agent, and the summary only says ONE exists.
   */
  const openThreadDraft = (): void => {
    if (open === null) return
    void trpc.google.drafts
      .query()
      .then((drafts) => {
        const mine = drafts.filter((draft) => draft.threadId === open.id)
        // Newest by date: `listDrafts` makes no ordering promise.
        const newest = mine.sort((a, b) => a.date.localeCompare(b.date)).pop()
        if (newest !== undefined) continueDraft(newest)
      })
      .catch(() => setWriteError('Could not open that draft.'))
  }

  /** Both exits from the composer refresh the Drafts list. */
  const closeComposer = (): void => {
    setComposing(null)
    setContinuing(undefined)
    setDraftsGeneration((generation) => generation + 1)
  }

  /**
   * After a send: close the composer, refetch the open thread and the list.
   */
  const onComposerSent = (): void => {
    const intent = composing
    closeComposer()
    if (open === null || intent === null || intent.kind === 'new') return

    void trpc.google.thread
      .query({ id: open.id })
      .then(setOpen)
      .catch(() => {
        // The send succeeded; only the refetch failed. Leave the thread as it
        // was rather than invent a message we cannot confirm arrived.
      })
    load()
  }

  /**
   * The next page, **appended**. A button rather than an infinite scroller:
   * Gmail is rate limited, and one trackpad flick would spend a minute's quota.
   */
  const loadMore = (pageToken: string) => {
    setLoadingMore(true)
    void trpc.google.threads
      .query({ query: submitted, category: filter, unread: unreadFilter, mailbox, pageToken })
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
      // A failed "load more" leaves what is already on screen alone.
      .finally(() => setLoadingMore(false))
  }

  /**
   * Open a thread.
   *
   * The row's **summary** is kept alongside the fetched thread: flags such as
   * the unsubscribe link come from the list response and are not refetched.
   */
  const openThread = (thread: ThreadSummary) => {
    // A find bar left open would count matches in the previous thread.
    setFindOpen(false)
    setOpenId(thread.id)
    setOpenSummary(thread)
    setOpen(null)
    setMeeting(null)
    void trpc.google.thread
      .query({ id: thread.id })
      .then(setOpen)
      .catch(() => setOpenId(null))
    // Only for a thread the list already says holds an `.ics`, to avoid two
    // requests per open. A failure is swallowed deliberately: the badge still
    // says this is a meeting, and a convenience lookup does not merit a banner.
    if (thread.hasInvite) {
      void trpc.google.meeting
        .query({ id: thread.id })
        .then((found) => {
          if (found !== null) setMeeting({ ...found, threadId: thread.id })
        })
        .catch(() => undefined)
    }
    // Only when there is something to change: the API is rate limited.
    if (thread.unread) void setRead(thread.id, true)
  }

  /**
   * A write, painted immediately and undone if Google refuses.
   *
   * **Optimism belongs here and nowhere below.** A revert costs a re-render and
   * nothing is persisted. `main` touches the cache only once Google has agreed,
   * because a cached write Google refused is a divergence the `history.list`
   * delta sync can never find.
   *
   * The whole previous list is the undo, rather than an inverse per operation:
   * a removed row goes back at its index, and "unarchive" is not expressible.
   */
  const write = async (
    mutate: () => Promise<unknown>,
    next: (threads: ThreadSummary[]) => ThreadSummary[],
  ) => {
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
       * list. Otherwise (another write in flight, a refresh after an archive)
       * restoring it would discard the other change, so re-read instead.
       */
      if (listGeneration.current === at) {
        setList((previous) =>
          previous.kind === 'ready' ? { ...previous, threads: snapshot } : previous,
        )
      } else {
        load()
      }
      // A silent revert is indistinguishable from the click never registering
      // (e.g. a grant missing `gmail.modify`), so always say why.
      setWriteError(explainWriteFailure(err))
    }
  }

  const setRead = (id: string, read: boolean) =>
    write(
      () => trpc.google.setRead.mutate({ id, read }),
      (threads) => threads.map((t) => (t.id === id ? { ...t, unread: !read } : t)),
    )

  const setStarred = (id: string, starred: boolean) =>
    write(
      () => trpc.google.setStarred.mutate({ id, starred }),
      (threads) => threads.map((t) => (t.id === id ? { ...t, starred } : t)),
    )

  /**
   * Archive and trash, which both take the thread out of the list.
   *
   * The reader closes with it, so `openSummary` does not go on rendering a
   * thread the list no longer holds.
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
   * The link is an ordinary markdown link in the task **body**, with no
   * frontmatter field, so "which tasks reference this thread" stays a grep.
   */
  const linkToTask = async (thread: { subject: string; webUrl: string }) => {
    if (remote === null) return
    const { path } = await trpc.tasks.create.mutate({
      remote,
      title: thread.subject,
      folder: '',
      description: `[${thread.subject}](${thread.webUrl})\n`,
    })
    openNote(path)
  }

  /**
   * Everything a thread can have done to it, passed to the row menu rather than
   * reimplemented there, so every action goes through `write`: the optimistic
   * paint, the undo generation check, and `explainWriteFailure`.
   */
  const threadActions: ThreadActions = {
    setRead,
    setStarred,
    archive: (id) => void removeThread(id, () => trpc.google.archive.mutate({ id })),
    trash: (id) => void removeThread(id, () => trpc.google.trash.mutate({ id })),
    linkToTask: (thread) => void linkToTask(thread),
    canLinkToTask: remote !== null,
    openExternal: (url) => void window.holi.openExternal(url),
  }

  // Memoised for the identity: a fresh `[]` every render would re-run `live`.
  const threads = useMemo(() => (list.kind === 'ready' ? list.threads : []), [list])

  /**
   * Selection, pruned to what is actually on screen: the list is replaced
   * wholesale by refreshes, writes and page loads, so an id can outlive its row.
   * Derived rather than synced by an effect, which would paint a stale count
   * for a frame.
   */
  const live = useMemo(() => {
    const present = new Set(threads.map((thread) => thread.id))
    return new Set([...selected].filter((id) => present.has(id)))
  }, [threads, selected])

  /**
   * Toggle one row, or extend from the last one toggled.
   *
   * Shift extends over the RENDERED order: what the user can see.
   */
  const toggleSelected = (id: string, extend: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (extend && anchor !== null) {
        const from = threads.findIndex((thread) => thread.id === anchor)
        const to = threads.findIndex((thread) => thread.id === id)
        if (from !== -1 && to !== -1) {
          const [lo, hi] = from < to ? [from, to] : [to, from]
          // A range ADDS to the selection rather than replacing it.
          for (const thread of threads.slice(lo, hi + 1)) next.add(thread.id)
          return next
        }
      }
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setAnchor(id)
  }

  const clearSelection = () => {
    setSelected(new Set())
    setAnchor(null)
  }

  /**
   * One bulk action: the same per-thread write, once per selected thread.
   *
   * The selection is cleared FIRST, so the bar does not describe rows that are
   * already leaving. Each `write` surfaces its own failure; the ones that
   * succeeded stay done.
   */
  const applyToSelection = (action: (id: string) => void) => {
    const ids = [...live]
    clearSelection()
    for (const id of ids) action(id)
  }

  /**
   * The open thread's row, as the list has it *now*.
   *
   * `openSummary` is the row as it was when opened, so it goes stale when the
   * thread is starred. The list is where flags move; `openSummary` is the
   * fallback for a thread the current list does not contain.
   */
  const openRow = threads.find((thread) => thread.id === openId) ?? openSummary

  /**
   * ⌘F, scoped to this pane.
   *
   * On the container rather than the document: a keydown only reaches here when
   * focus is already inside, so mail's ⌘F does not steal it from other surfaces.
   */
  const onKeyDown = (event: React.KeyboardEvent) => {
    // Escape drops a selection.
    if (event.key === 'Escape' && selected.size > 0) {
      event.preventDefault()
      clearSelection()
      return
    }
    if (!matchHotkey(event.nativeEvent, '⌘F')) return
    event.preventDefault()
    /**
     * From the reader, ⌘F finds in the open thread; from the list, it opens the
     * list search. The reader is marked with a data attribute because a keydown
     * forwarded out of a message frame is re-dispatched on the frame element and
     * has to land in the same branch.
     */
    const fromReader =
      openId !== null &&
      event.target instanceof Element &&
      event.target.closest('[data-mail-pane="reader"]') !== null
    if (fromReader) setFindOpen(true)
    else setSearchOpen(true)
  }

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="h-full min-h-0"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
      onKeyDown={onKeyDown}
    >
      {/* The list, resizable: no fixed width suits both wide and narrow windows. */}
      <ResizablePanel id="mail-list" defaultSize={320} minSize={220} maxSize={640}>
        <div className="flex h-full min-h-0 flex-col">
          {live.size > 0 ? (
            <SelectionBar
              count={live.size}
              onSetRead={(read) => applyToSelection((id) => void setRead(id, read))}
              onSetStarred={(starred) => applyToSelection((id) => void setStarred(id, starred))}
              onArchive={() => applyToSelection(threadActions.archive)}
              onTrash={() => applyToSelection(threadActions.trash)}
              onClear={clearSelection}
            />
          ) : (
            <MailToolbar
              query={query}
              onQueryChange={setQuery}
              onSubmit={setSubmitted}
              searchOpen={searchOpen}
              onSearchOpenChange={setSearchOpen}
              people={threads}
              contacts={contacts}
              view={view}
              onViewChange={setView}
              searching={searching}
              unreadOnly={unreadOnly}
              onUnreadChange={setUnreadOnly}
              unreadCount={viewUnread(view, counts?.unread ?? null, categoryCounts)}
              inboxUnread={counts?.unread ?? null}
              categoryCounts={categoryCounts}
              onCategoryMenuOpen={loadCategoryCounts}
              onCompose={() => openDialog({ id: 'compose-mail', size: 'lg' })}
              onRefresh={() => {
                load()
                loadCounts()
                // Only if already loaded: refresh must not be what first spends
                // five requests on a dropdown.
                if (categoryCounts !== null) loadCategoryCounts()
              }}
            />
          )}

          {/* Above the list rather than beside the button that failed: archive
              and trash close the reader, so a message anchored there would
              vanish with the pane that raised it. */}
          {writeError !== null && (
            <div className="flex shrink-0 items-start gap-2 border-b border-border bg-secondary px-3 py-1.5 text-[11px] text-amber-400">
              <span className="min-w-0 flex-1">{writeError}</span>
              <IconButton icon={X} label="dismiss" onClick={() => setWriteError(null)} />
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto">
            {showDrafts && <DraftsList reloadKey={draftsGeneration} onOpen={continueDraft} />}
            {!showDrafts && list.kind === 'loading' && <Note>Loading…</Note>}
            {!showDrafts && list.kind === 'disconnected' && (
              <Note>Google isn&rsquo;t connected. Connect it in vault settings.</Note>
            )}
            {!showDrafts && list.kind === 'error' && <Note>{list.message}</Note>}
            {/* Names the filter: an empty tab and an empty mailbox otherwise
                look identical. */}
            {!showDrafts && list.kind === 'ready' && list.threads.length === 0 && (
              <Note>{emptyMessage(view, filter, unreadOnly)}</Note>
            )}
            {!showDrafts &&
              list.kind === 'ready' &&
              list.threads.map((thread) => (
                <ThreadMenu
                  key={thread.id}
                  thread={thread}
                  actions={threadActions}
                  onOpen={() => openThread(thread)}
                >
                  <ThreadRow
                    thread={thread}
                    active={openId === thread.id}
                    onOpen={() => openThread(thread)}
                    selected={live.has(thread.id)}
                    onToggle={({ extend }) => toggleSelected(thread.id, extend)}
                    showCheckbox={live.size > 0}
                  />
                </ThreadMenu>
              ))}
            {!showDrafts && list.kind === 'ready' && list.nextPageToken !== null && (
              <div className="p-2">
                {/* A button, not an infinite scroller: see `loadMore`. */}
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

      {/* The divider IS the handle, so the list has no border of its own. */}
      <ResizableHandle />

      {/* The reader */}
      <ResizablePanel id="mail-reader" minSize={280}>
        <div className="flex h-full min-h-0 min-w-0 flex-col" data-mail-pane="reader">
          {/* A draft opened from the Drafts list has no thread behind it, so
              it goes in the reader pane. */}
          {composing !== null && openId === null ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              <MailComposer
                key={composeKey}
                intent={composing}
                draftId={continuing}
                sendAs={sendAs}
                suggestions={contacts}
                onSent={onComposerSent}
                onDiscarded={closeComposer}
                onClose={closeComposer}
              />
            </div>
          ) : openId === null ? (
            <Note>Pick a thread to read it.</Note>
          ) : open === null ? (
            <Note>Loading…</Note>
          ) : (
            <>
              <div className="flex h-11 shrink-0 items-center gap-2 px-4">
                <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{open.subject}</h3>
                {/* First, as the only time-sensitive action. The link is NOT
                    parsed out of the invite: main matched its `UID` to the
                    calendar event, and this is that event's `conferenceUrl`,
                    falling back to the event's page. */}
                {meeting !== null && meeting.threadId === openId && (
                  <Tooltip
                    content={
                      meeting.conferenceUrl !== null
                        ? `join ${meeting.title}`
                        : `open ${meeting.title} in Google Calendar`
                    }
                  >
                    <Button
                      variant="secondary"
                      size="xs"
                      className="shrink-0 gap-1"
                      aria-label={
                        meeting.conferenceUrl !== null
                          ? 'join this meeting'
                          : 'open this meeting in Google Calendar'
                      }
                      onClick={() =>
                        void window.holi.openExternal(meeting.conferenceUrl ?? meeting.htmlLink)
                      }
                    >
                      <Icon
                        icon={meeting.conferenceUrl !== null ? Video : CalendarDays}
                        size="sm"
                      />
                      {meeting.conferenceUrl !== null ? 'Join' : 'Meeting'}
                    </Button>
                  </Tooltip>
                )}
                {/* Goes to a real session, where follow-up questions live. It
                    lands unsent like every other ask. */}
                <Tooltip content="ask the vault assistant to summarise this thread">
                  <Button
                    variant="secondary"
                    size="xs"
                    className="shrink-0 gap-1"
                    onClick={() => void summarize()}
                  >
                    <Icon icon={Sparkles} size="sm" />
                    Summarize
                  </Button>
                </Tooltip>
                <Tooltip content="make a task linking this thread">
                  <Button
                    variant="secondary"
                    size="xs"
                    className="shrink-0 gap-1"
                    disabled={remote === null}
                    onClick={() => void linkToTask(open)}
                  >
                    <Icon icon={Link2} size="sm" />
                    Task
                  </Button>
                </Tooltip>
                {/* Advertised by the sender in List-Unsubscribe. Opened, never
                    requested: it is a URL a stranger chose. */}
                {openRow?.unsubscribeUrl != null && (
                  <Tooltip content="open this sender’s unsubscribe page">
                    <Button
                      variant="ghost"
                      size="xs"
                      className="shrink-0 gap-1"
                      aria-label="unsubscribe from this sender"
                      onClick={() => void window.holi.openExternal(openRow.unsubscribeUrl!)}
                    >
                      <Icon icon={MailMinus} size="sm" />
                      Unsubscribe
                    </Button>
                  </Tooltip>
                )}
                {/* Triage. Star is a toggle that says which way it goes;
                    archive and trash both take the thread out of the list. */}
                <IconButton
                  // Filled means starred.
                  icon={Star}
                  filled={openRow?.starred === true}
                  label={openRow?.starred === true ? 'unstar this thread' : 'star this thread'}
                  tooltip={openRow?.starred === true ? 'unstar' : 'star'}
                  onClick={() => void setStarred(open.id, openRow?.starred !== true)}
                />
                <IconButton
                  icon={Archive}
                  label="archive this thread"
                  tooltip="archive — removes it from the inbox, keeps it in All Mail"
                  onClick={() =>
                    void removeThread(open.id, () => trpc.google.archive.mutate({ id: open.id }))
                  }
                />
                {/* Trash, which Gmail keeps for 30 days. Not called Delete:
                    Holi has no scope to delete mail permanently. */}
                <IconButton
                  icon={Trash2}
                  label="move this thread to trash"
                  tooltip="move to trash — recoverable for 30 days"
                  onClick={() =>
                    void removeThread(open.id, () => trpc.google.trash.mutate({ id: open.id }))
                  }
                />
                {/* Reply, reply-all and forward all open the same inline
                    composer below. `replyTarget` rather than the last message:
                    replying to your own last reply addresses you. */}
                <IconButton icon={Reply} label="reply" onClick={() => startCompose(false)} />
                <IconButton
                  icon={ReplyAll}
                  label="reply to everyone"
                  onClick={() => startCompose(true)}
                />
                {/* "Continue draft": opens the thread's NEWEST unsent draft.
                    Any other is reachable from the Drafts list. */}
                {openSummary?.hasDraft === true && (
                  <IconButton
                    icon={FilePen}
                    label="continue draft"
                    tooltip="continue your draft"
                    onClick={openThreadDraft}
                  />
                )}
                <IconButton icon={Forward} label="forward" onClick={startForward} />
                <IconButton
                  icon={ExternalLink}
                  label="open in Gmail"
                  onClick={() => void window.holi.openExternal(open.webUrl)}
                />
              </div>

              {/* One scroller for the whole thread. Each message renders at its
                  full height inside it: see `SandboxedHtml` for how a frame is
                  sized to its content. */}
              {findOpen && (
                <ThreadFind
                  messageIds={open.messages.map((message) => message.id)}
                  scroller={readerRef.current}
                  onClose={() => setFindOpen(false)}
                />
              )}

              <div ref={readerRef} className="min-h-0 flex-1 overflow-y-auto px-4 pb-8">
                {open.messages.map((message, index) => (
                  <MessageBlock
                    key={message.id}
                    message={message}
                    threadUrl={open.webUrl}
                    // Only the last message opens expanded, as in Gmail, so a
                    // long thread does not bury what is new.
                    initiallyOpen={index === open.messages.length - 1}
                    position={index + 1}
                    total={open.messages.length}
                    forceExpanded={findOpen}
                  />
                ))}

                {/* Inline, at the foot of the thread, inside the same scroller,
                    so the message being answered stays on screen. */}
                {composing !== null && (
                  <MailComposer
                    key={composeKey}
                    intent={composing}
                    draftId={continuing}
                    sendAs={sendAs}
                    suggestions={contacts}
                    onSent={onComposerSent}
                    onDiscarded={closeComposer}
                    onClose={closeComposer}
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
 * The scope case is singled out: it is the likeliest, the user can fix it, and
 * its symptom is otherwise silence (mail loads, only writes fail).
 *
 * **The code first, the prose second.** The router maps `GoogleApiError.code`
 * onto a tRPC code (`rethrowGoogle`) so this does not read Google's sentences.
 * The regexes are the fallback for an error that arrives without a code.
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

/**
 * The unread number the toggle should be showing, for the selected view.
 *
 * A tab's own count comes from `categoryCounts`, which is **not fetched until
 * the picker is opened** (see `loadCategoryCounts`). An unknown count shows
 * NOTHING, as in the picker: absent says "not known", `0` says "nothing here".
 */
function viewUnread(
  view: MailboxView,
  inboxUnread: number | null,
  counts: CategoryCounts | null,
): number | null {
  if (view.kind !== 'category') return null
  if (view.category === null) return inboxUnread
  return counts?.[view.category]?.count ?? null
}

/**
 * Why the list is empty, in the terms the user set it to be.
 *
 * Naming the filter matters: an empty tab and an empty mailbox look identical
 * otherwise. The tabs sentence is only appended for a *tab*.
 */
function emptyMessage(
  view: MailboxView,
  filter: MailCategory | undefined,
  unreadOnly: boolean,
): string {
  if (view.kind === 'sent') return 'Nothing sent.'
  if (filter === undefined) return unreadOnly ? 'Nothing unread.' : 'No threads.'
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
 * Search is an **icon until it is wanted**: a permanently open field would cost
 * this narrow panel a whole row.
 */
function MailToolbar({
  query,
  onQueryChange,
  onSubmit,
  searchOpen,
  onSearchOpenChange,
  people,
  contacts,
  view,
  onViewChange,
  searching,
  unreadOnly,
  onUnreadChange,
  unreadCount,
  inboxUnread,
  categoryCounts,
  onCategoryMenuOpen,
  onCompose,
  onRefresh,
}: {
  query: string
  onQueryChange: (value: string) => void
  onSubmit: (value: string) => void
  searchOpen: boolean
  onSearchOpenChange: (open: boolean) => void
  people: ThreadSummary[]
  contacts: MailAddress[]
  view: MailboxView
  onViewChange: (view: MailboxView) => void
  searching: boolean
  unreadOnly: boolean
  onUnreadChange: (unread: boolean) => void
  unreadCount: number | null
  inboxUnread: number | null
  categoryCounts: CategoryCounts | null
  onCategoryMenuOpen: () => void
  onCompose: () => void
  onRefresh: () => void
}): React.JSX.Element {
  const searchButtonRef = useRef<HTMLButtonElement>(null)
  /**
   * Closing the search must hand the keyboard back to the pane.
   *
   * ⌘F is bound on the pane's container, so focus escaping to `document.body`
   * when the input unmounts would make it dead. Focus goes to the icon that
   * replaces the field. Guarded on `wasOpen` so mounting the pane does not
   * steal focus.
   */
  const wasOpen = useRef(searchOpen)
  useEffect(() => {
    if (wasOpen.current && !searchOpen) searchButtonRef.current?.focus()
    wasOpen.current = searchOpen
  }, [searchOpen])

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
      <IconButton
        ref={searchButtonRef}
        icon={Search}
        label="search mail"
        tooltip="search mail (⌘F)"
        onClick={() => onSearchOpenChange(true)}
      />

      {/* A state, not a place: it survives a search, and it is a toggle rather
          than an entry in the picker. Absent for Sent and Drafts. */}
      {view.kind === 'category' && (
        <Tooltip content={unreadOnly ? 'showing unread only' : 'show unread only'}>
          <Button
            variant={unreadOnly ? 'secondary' : 'ghost'}
            size="xs"
            className="gap-1"
            aria-label="show unread only"
            aria-pressed={unreadOnly}
            onClick={() => onUnreadChange(!unreadOnly)}
          >
            <Icon icon={MailOpen} size="sm" />
            {unreadCount !== null && unreadCount > 0 && (
              <span className="text-[10px] text-muted-foreground">{unreadCount}</span>
            )}
          </Button>
        </Tooltip>
      )}

      {/* Gone during a search, as Gmail's own tabs are: a picker reading
          "Promotions" over unfiltered results claims a filter not applied. */}
      {!searching && (
        <MailboxPicker
          view={view}
          onChange={onViewChange}
          counts={categoryCounts}
          inboxUnread={inboxUnread}
          onOpen={onCategoryMenuOpen}
        />
      )}

      {/* Compose and refresh, together at the right end. */}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {/* A new message is a DIALOG, where a reply is inline: a fresh message
            has no context to preserve. */}
        <IconButton
          icon={SquarePen}
          label="new message"
          tooltip="write a new message"
          onClick={onCompose}
        />
        <IconButton icon={RefreshCw} label="refresh mail" tooltip="refresh" onClick={onRefresh} />
      </div>
    </div>
  )
}

/**
 * The unfolded search box, with people completion on `@`.
 *
 * Enter submits. No `<form>`: the gate keeps native elements inside
 * `primitives/`.
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

  // The click that opened the field is the intent to type.
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
      // Enter completes the mention rather than running the search.
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
      <Icon icon={Search} size="sm" tone="muted" />
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
      <IconButton icon={X} label="close search" onClick={onClose} />

      {matches.length > 0 && (
        <ul
          id="mail-people"
          role="listbox"
          className="absolute top-8 right-0 left-0 z-20 max-h-56 overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-md"
        >
          {matches.map((person, index) => (
            // The button IS the option, not a child of one, so the clicked and
            // the announced element are the same.
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
  /** How many loaded threads they sent. The ranking key. */
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
 * The `@` must **start a word**: preceded by nothing, whitespace, or the `:` of
 * `from:`/`to:`. Otherwise an accepted address (`from:jane@syv.ai`) would
 * reopen the list on its own separator. And nothing since the `@` may be
 * whitespace.
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

/** The completed query, in Gmail's own `from:` grammar so the user can still
 *  edit it. */
export function replaceMention(query: string, mention: Mention, email: string): string {
  const before = query.slice(0, mention.start)
  // `@` is dropped: `from:@jane@x.ai` is not valid Gmail grammar.
  return `${before}${before.endsWith('from:') || before.endsWith('to:') ? '' : 'from:'}${email} `
}

/**
 * People to complete from: **two sources, ranked by evidence**.
 *
 * 1. Senders across the loaded threads, counted: the strongest signal, and free.
 * 2. The address book, from the People API (`contacts.readonly`). Broader, but
 *    with no frequency to rank on, so it sits behind.
 *
 * The local corpus is deliberately **not** replaced by contacts: it keeps
 * completion working when the contacts request is cold, refused, or unscoped.
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
  // `count: 0` ranks the address book below every sender. This loop runs second
  // so a contact already seen as a sender keeps its count.
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
 * The counts are **exact**: Gmail's per-label bookkeeping, not the
 * `resultSizeEstimate` the category picker refuses to show. When the request
 * fails there is simply no number.
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
    <div className="flex h-7 shrink-0 items-center justify-between gap-2 border-t border-divider px-2 text-[10px] text-muted-foreground">
      <span className="flex min-w-0 items-center gap-1 truncate">
        <Icon icon={RefreshCw} size="sm" className={syncing ? 'motion-orbit' : undefined} />
        {syncing ? 'Syncing…' : syncedAt === null ? 'Not synced' : `Synced ${ago(syncedAt)}`}
      </span>
      <span className="shrink-0">
        {counts === null
          ? // Only what is on screen: "0 unread" would be a claim.
            `${shown} shown`
          : `${counts.unread} unread · ${counts.total} in inbox`}
      </span>
    </div>
  )
}

/** Coarse on purpose: nobody needs mail sync time to the second. */
function ago(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

/**
 * One thread in the list.
 *
 * **The checkbox is a SIBLING of the clickable area, not inside it**: a control
 * inside a button is invalid and its click would be swallowed.
 *
 * The checkbox appears on hover, and stays visible for every row once anything
 * is selected.
 */
function ThreadRow({
  thread,
  active,
  onOpen,
  selected,
  onToggle,
  showCheckbox,
}: {
  thread: ThreadSummary
  active: boolean
  onOpen: () => void
  selected: boolean
  /** `extend` is a shift-click: take everything between the last toggle and
   *  this one. */
  onToggle: (options: { extend: boolean }) => void
  showCheckbox: boolean
}): React.JSX.Element {
  // Not Primary, and in a tab at all: `categoryLabelOf(null)` is no tab.
  const categoryLabel = thread.category === 'primary' ? null : categoryLabelOf(thread.category)
  const chips = categoryLabel !== null || thread.labels.length > 0
  const subjectWeight = thread.unread ? 'font-medium' : ''

  return (
    <div
      className={`motion-respond group/row flex items-stretch border-b border-divider ${
        active
          ? 'bg-secondary'
          : selected
            ? 'bg-primary/10 hover:bg-primary/20'
            : 'hover:bg-accent/40'
      }`}
    >
      <div
        className={`flex shrink-0 items-center pl-1.5 ${
          showCheckbox || selected ? '' : 'opacity-0 group-hover/row:opacity-100'
        }`}
      >
        <Checkbox
          checked={selected}
          aria-label={`select ${thread.subject}`}
          // `--input` and `--secondary` are the same neutral, so on the OPEN row
          // an unchecked box's border would vanish. Fixed here rather than by
          // moving `--input`, which every input draws its edge from.
          className={active ? 'border-muted-foreground' : ''}
          // onClick rather than the Radix change event: shift-click needs the
          // modifier, and `onCheckedChange` is handed only a boolean.
          onClick={(event) => {
            event.stopPropagation()
            onToggle({ extend: event.shiftKey })
          }}
        />
      </div>
      <Button
        variant="ghost"
        onClick={(event) => {
          // Cmd/Ctrl-click selects instead of opening, as OS lists do.
          if (event.metaKey || event.ctrlKey || event.shiftKey) {
            event.preventDefault()
            onToggle({ extend: event.shiftKey })
            return
          }
          onOpen()
        }}
        className="block h-auto min-w-0 flex-1 rounded-none bg-transparent py-3 pr-3 pl-2 text-left hover:bg-transparent"
      >
        {/* Two columns: only the text column shrinks, so it truncates against
            the rail instead of pushing it off the row. */}
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2">
              {/* An unread dot, since weight alone is too quiet to scan. It
                  always holds the left edge so read and unread stay aligned. */}
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
              </span>
              {/* These three stay on the sender's line: they are things *you*
                  did, where the rail holds what the thread is. */}
              {thread.starred && (
                <span role="img" aria-label="starred" className="flex shrink-0 self-center">
                  <Icon icon={Star} size="sm" tone="muted" />
                </span>
              )}
              {/* "You started replying and stopped". */}
              {thread.hasDraft && (
                <span role="img" aria-label="unsent draft" className="flex shrink-0 self-center">
                  <Icon icon={FilePen} size="sm" tone="muted" />
                </span>
              )}
              {/* "You replied and are waiting on them": see `answered` in
                  main/google/gmail.ts for why the LAST message decides. */}
              {thread.answered && (
                <span role="img" aria-label="you replied" className="flex shrink-0 self-center">
                  <Icon icon={Reply} size="sm" tone="muted" />
                </span>
              )}
            </span>
            <span className={`mt-0.5 block truncate pl-3.5 text-xs ${subjectWeight}`}>
              {thread.subject}
            </span>
            <span className="mt-0.5 block truncate pl-3.5 text-[11px] text-muted-foreground">
              {thread.snippet}
            </span>
            {chips && (
              <span className="mt-1.5 flex flex-wrap gap-1 pl-3.5">
                {/* Outlined, where a user label is filled: the tab is Gmail's
                    classification, not a label the reader chose. */}
                {categoryLabel !== null && (
                  <span className="rounded border border-border px-1 py-px text-[10px] text-muted-foreground">
                    {categoryLabel}
                  </span>
                )}
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
          </span>

          {/* The metadata rail: what the thread *is*, right-aligned, stacked
              under the stamp. It takes the width it needs and no more;
              `whitespace-nowrap` is what stops flexbox narrowing it and
              wrapping the stamp instead of truncating the text. */}
          <span
            data-thread-meta
            className="flex shrink-0 flex-col items-end gap-0.5 whitespace-nowrap text-[10px] text-muted-foreground"
          >
            <span>{listStamp(thread.date)}</span>
            {(thread.hasInvite || thread.messageCount > 1) && (
              <span className="flex items-center gap-1">
                {/* A meeting, not a message: the second has a deadline. */}
                {thread.hasInvite && (
                  <span role="img" aria-label="meeting invite" className="flex">
                    <Icon icon={CalendarDays} size="sm" />
                  </span>
                )}
                {thread.messageCount > 1 && <span>({thread.messageCount})</span>}
              </span>
            )}
          </span>
        </span>
      </Button>
    </div>
  )
}

/**
 * One message in a thread, collapsible.
 *
 * Collapsed shows who, when, where in the thread, and the start of the body.
 * Only expanded messages build a frame.
 */
function MessageBlock({
  message,
  threadUrl,
  initiallyOpen,
  position,
  total,
  forceExpanded,
}: {
  message: ThreadMessage
  threadUrl: string
  initiallyOpen: boolean
  /** 1-based, as it reads on screen. */
  position: number
  total: number
  /**
   * Open regardless of what the reader chose, while a find is running.
   *
   * A collapsed message has no frame, so it cannot be searched. Layered OVER
   * the local state, so closing the find restores the reader's collapse.
   */
  forceExpanded: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(initiallyOpen)
  const shown = expanded || forceExpanded

  return (
    <article className="border-b border-divider py-2 last:border-0">
      {/* The whole header is the toggle. */}
      <Button
        variant="ghost"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={shown}
        aria-label={`${shown ? 'collapse' : 'expand'} message ${position} of ${total} from ${message.from.name}`}
        className="block h-auto w-full rounded px-1 py-1 text-left"
      >
        <span className="flex items-baseline gap-2 text-xs">
          <Icon
            icon={shown ? ChevronDown : ChevronRight}
            size="sm"
            tone="muted"
            className="self-center"
          />
          <span className="min-w-0 flex-1 truncate font-medium">{message.from.name}</span>
          {/* Where you are in the conversation. Suppressed on a one-message
              thread, where "1/1" is noise. */}
          {total > 1 && (
            <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
              {position}/{total}
            </span>
          )}
          <span className="shrink-0 text-muted-foreground">{messageStamp(message.date)}</span>
        </span>
        {!shown && (
          <span className="block truncate pl-5 text-[11px] text-muted-foreground">
            {message.body.slice(0, 200)}
          </span>
        )}
      </Button>

      {shown && (
        <div className="pl-1">
          <MessageAddresses message={message} />
          <MessageBody message={message} />
          <Attachments attachments={message.attachments} webUrl={threadUrl} />
        </div>
      )}
    </article>
  )
}

/**
 * Who a message went to, as labelled rows rather than as a sentence.
 *
 * **A row is absent, never empty.** `From` is always there; the other three
 * appear only when the header carried something.
 *
 * **`Bcc` will be empty on almost everything, and that is correct.** Gmail
 * strips it from received mail; it survives only on mail the account sent.
 */
function MessageAddresses({ message }: { message: ThreadMessage }): React.JSX.Element {
  const rows: { label: string; addresses: MailAddress[] }[] = [
    { label: 'From', addresses: [message.from] },
    { label: 'To', addresses: message.to },
    { label: 'Cc', addresses: message.cc },
    { label: 'Bcc', addresses: message.bcc },
  ]

  return (
    <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-2 text-[11px] text-muted-foreground">
      {rows
        .filter((row) => row.addresses.length > 0)
        .map((row) => (
          <div key={row.label} className="col-span-2 grid grid-cols-subgrid items-baseline">
            <dt className="shrink-0">{row.label}</dt>
            <dd className="flex min-w-0 flex-wrap items-baseline gap-x-1">
              <AddressList addresses={row.addresses} />
            </dd>
          </div>
        ))}
    </dl>
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
 * The popover shows what Holi actually knows, name and address, turning a
 * display name back into the address it stands for.
 *
 * "Email" is a **`mailto:` handoff** to the OS's mail client, not Holi's
 * composer.
 */
function AddressLink({ address }: { address: MailAddress }): React.JSX.Element {
  // A `From` the parser could not read: shown, but not clickable.
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
            <Icon icon={Reply} size="sm" />
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
 * Every one **opens the thread in Gmail** rather than downloading: Holi does
 * not fetch attachment bytes.
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
              <Icon
                icon={attachment.mimeType.startsWith('image/') ? Paperclip : FileText}
                size="sm"
              />
              <span className="max-w-48 truncate">{attachment.filename}</span>
              <span className="text-muted-foreground">{fileSize(attachment.size)}</span>
            </Button>
          </Tooltip>
        </li>
      ))}
    </ul>
  )
}

/** Bytes as a person reads them. One decimal below 10 units, none above. */
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
 * "Load images" is per message rather than per thread: a user trusts *this*
 * newsletter, not the whole thread. `SandboxedHtml` holds that and the frame,
 * shared with calendar event descriptions.
 */
function MessageBody({ message }: { message: ThreadMessage }) {
  if (message.html === null) {
    // Marked so in-thread find can reach it: a text-only message publishes no
    // frame to the registry.
    return (
      <p
        {...{ [MESSAGE_BODY_ATTR]: message.id }}
        className="whitespace-pre-wrap break-words text-sm"
      >
        {message.body}
      </p>
    )
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
