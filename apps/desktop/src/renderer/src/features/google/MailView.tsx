/**
 * Mail — search, read, and link a thread into the vault.
 *
 * A list on the left, the open thread on the right. Deliberately **not** an
 * email client (PRD non-goal): there is no archive, no label, no delete, and no
 * reply box. Replying opens Gmail, because the scope Holi holds is read-only
 * and pretending otherwise would be a button that cannot work.
 *
 * **Bodies are sanitized HTML in a sandboxed frame** (D67, revised). A message
 * arrives with both an `html` part and a plain-text one; HTML wins when it
 * exists, because mail is designed and a reader that flattens every newsletter
 * to text is not a reader. The two defences that make that safe, and the
 * blocking of remote content, live in [[SandboxedHtml]] — shared with the
 * agenda, whose event descriptions are third-party HTML by the same logic.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  ExternalLink,
  FileText,
  Link2,
  Mail,
  MailMinus,
  Paperclip,
  PenLine,
  RefreshCw,
  Reply,
  Search,
  Star,
} from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  Tooltip,
} from '@/primitives'
import { SandboxedHtml } from './SandboxedHtml'
import { trpc } from '../../lib/trpc'
import { activeRemoteAtom } from '../../state/vaults'
import { openNoteTabAtom } from '../../state/panes'
import { useGlobalPanelLayout } from '../../state/preferences'

/** Mirrors `main/google/gmail.ts`. */
type MailCategory = 'primary' | 'social' | 'promotions' | 'updates' | 'forums'

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
  from: string
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

interface Attachment {
  filename: string
  mimeType: string
  size: number
}

interface ThreadMessage {
  id: string
  from: string
  to: string[]
  cc: string[]
  date: string
  /** Plain text — the fallback, and what a text-only message carries. */
  body: string
  /** Raw, unsanitized HTML, or null. Only `MessageBody` may touch this. */
  html: string | null
  attachments: Attachment[]
}

interface Thread {
  id: string
  subject: string
  webUrl: string
  messages: ThreadMessage[]
}

type ListState =
  | { kind: 'loading' }
  | {
      kind: 'ready'
      threads: ThreadSummary[]
      /** null when Gmail says there is nothing further. */
      nextPageToken: string | null
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
  const [list, setList] = useState<ListState>({ kind: 'loading' })
  const [open, setOpen] = useState<Thread | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [openSummary, setOpenSummary] = useState<ThreadSummary | null>(null)
  /** Which Gmail tab the list is showing; `null` is the whole inbox, and the
   *  default — see `CATEGORIES`. */
  const [category, setCategory] = useState<MailCategory | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
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
    void trpc.google.threads
      .query({ query: submitted, category: filter })
      .then((page) =>
        setList({ kind: 'ready', threads: page.threads, nextPageToken: page.nextPageToken }),
      )
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Could not load your mail.'
        setList(NOT_CONNECTED.test(message) ? { kind: 'disconnected' } : { kind: 'error', message })
      })
  }, [submitted, filter])

  useEffect(load, [load])

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
      .query({ query: submitted, category: filter, pageToken })
      .then((page) => {
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

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="h-full min-h-0"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
    >
      {/* The list. Was a fixed `w-80`, which is the wrong constant for both ends
          of the range this view is actually used at — a long subject truncates
          to uselessness on a wide window, and on a narrow one the list crowds
          out the message it exists to open. */}
      <ResizablePanel id="mail-list" defaultSize={320} minSize={220} maxSize={640}>
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex h-11 shrink-0 items-center gap-1 px-2">
            <h2 className="flex items-center gap-2 px-1 text-sm font-medium">
              <Mail size={15} />
              Mail
            </h2>
            {/* Gone during a search, as Gmail's own tabs are: a picker reading
              "Promotions" over unfiltered results claims a filter that is not
              applied. Clearing the search brings it back. */}
            {submitted === '' && <CategoryPicker category={category} onChange={setCategory} />}
            <Tooltip content="refresh">
              <Button variant="ghost" size="icon-xs" aria-label="refresh mail" onClick={load}>
                <RefreshCw size={14} />
              </Button>
            </Tooltip>
          </div>

          {/* Enter submits. No <form> — the gate keeps native elements inside
            primitives/, and a search box needs nothing a form would add. */}
          <div className="flex shrink-0 items-center gap-1 px-2 pb-2">
            <Search size={14} className="shrink-0 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setSubmitted(query)
              }}
              placeholder="Search mail — Gmail syntax"
              className="h-7 text-xs"
              aria-label="search mail"
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {list.kind === 'loading' && <Note>Loading…</Note>}
            {list.kind === 'disconnected' && (
              <Note>Google isn&rsquo;t connected. Connect it in vault settings.</Note>
            )}
            {list.kind === 'error' && <Note>{list.message}</Note>}
            {/* Naming the tab matters: an empty tab and an empty mailbox look
              identical otherwise, which is exactly how defaulting to Primary
              read as "my mail is gone" on an inbox that has no tabs. */}
            {list.kind === 'ready' && list.threads.length === 0 && (
              <Note>
                {filter === undefined
                  ? 'No threads.'
                  : `Nothing in ${CATEGORIES.find((c) => c.value === filter)?.label ?? filter}. Gmail’s tabs only apply if your inbox uses them.`}
              </Note>
            )}
            {list.kind === 'ready' &&
              list.threads.map((thread) => (
                <Button
                  key={thread.id}
                  variant="ghost"
                  onClick={() => openThread(thread)}
                  className={`block h-auto w-full rounded-none border-b border-border/50 px-3 py-2 text-left ${
                    openId === thread.id ? 'bg-secondary' : ''
                  }`}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    {/* Weight alone was too quiet to scan — an explicit dot is
                      what makes unread readable at a glance, and it holds the
                      row's left edge so read and unread stay aligned. */}
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
                      {thread.from}
                      {thread.messageCount > 1 && (
                        <span className="ml-1 text-muted-foreground">({thread.messageCount})</span>
                      )}
                    </span>
                    {/* "You replied and are waiting on them" — see `answered` in
                      main/google/gmail.ts for why it is the LAST message that
                      decides, not whether a reply exists anywhere. */}
                    {thread.starred && (
                      <Star
                        size={11}
                        className="shrink-0 self-center text-muted-foreground"
                        aria-label="starred"
                      />
                    )}
                    {/* "You started replying and stopped" — a third state,
                      distinct from both answered and untouched, and the only
                      trace of it anywhere in the list. */}
                    {thread.hasDraft && (
                      <PenLine
                        size={11}
                        className="shrink-0 self-center text-muted-foreground"
                        aria-label="unsent draft"
                      />
                    )}
                    {thread.answered && (
                      <Reply
                        size={11}
                        className="shrink-0 self-center text-muted-foreground"
                        aria-label="you replied"
                      />
                    )}
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {shortDate(thread.date)}
                    </span>
                  </span>
                  <span
                    className={`block truncate pl-3.5 text-xs ${thread.unread ? 'font-medium' : ''}`}
                  >
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
                {openSummary?.unsubscribeUrl != null && (
                  <Tooltip content="open this sender’s unsubscribe page">
                    <Button
                      variant="ghost"
                      size="xs"
                      className="shrink-0 gap-1"
                      aria-label="unsubscribe from this sender"
                      onClick={() => void window.holi.openExternal(openSummary.unsubscribeUrl!)}
                    >
                      <MailMinus size={13} />
                      Unsubscribe
                    </Button>
                  </Tooltip>
                )}
                {/* Reply is a handoff, not a compose box: the granted scope is
                  read-only, so Holi cannot send and does not pretend to. */}
                <Tooltip content="reply in Gmail">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="reply in Gmail"
                    onClick={() => void window.holi.openExternal(open.webUrl)}
                  >
                    <Reply size={14} />
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

              <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8">
                {open.messages.map((message) => (
                  <article
                    key={message.id}
                    className="border-b border-border/50 py-3 last:border-0"
                  >
                    <header className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                      <span className="min-w-0 truncate font-medium">{message.from}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {shortDate(message.date)}
                      </span>
                    </header>
                    {message.to.length > 0 && (
                      <p className="mb-2 truncate text-[11px] text-muted-foreground">
                        to {message.to.join(', ')}
                        {message.cc.length > 0 && ` · cc ${message.cc.join(', ')}`}
                      </p>
                    )}
                    <MessageBody message={message} />
                    <Attachments attachments={message.attachments} webUrl={open.webUrl} />
                  </article>
                ))}
              </div>
            </>
          )}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="p-6 text-center text-sm text-muted-foreground">{children}</p>
}

/**
 * Which Gmail tab the list is showing.
 *
 * Deliberately **no per-category counts**, which the design mock had: each
 * would cost a request, and Gmail's `resultSizeEstimate` is an estimate. A
 * count that is wrong is worse than no count — it is a number people trust.
 */
function CategoryPicker({
  category,
  onChange,
}: {
  category: MailCategory | null
  onChange: (category: MailCategory | null) => void
}) {
  const current = CATEGORIES.find((c) => c.value === category)
  return (
    <DropdownMenu>
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
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
  return <SandboxedHtml html={message.html} label={`message from ${message.from}`} />
}
