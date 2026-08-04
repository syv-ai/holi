/**
 * Mail — search, read, and link a thread into the vault.
 *
 * A list on the left, the open thread on the right. Deliberately **not** an
 * email client (PRD non-goal): there is no archive, no label, no delete, and no
 * reply box. Replying opens Gmail, because the scope Holi holds is read-only
 * and pretending otherwise would be a button that cannot work.
 *
 * **Bodies are sanitized HTML** (D67, revised). A message arrives with both a
 * `html` part and a plain-text one; HTML wins when it exists, because mail is
 * designed and a reader that flattens every newsletter to text is not a reader.
 * The HTML is attacker-controlled, so it goes through `sanitizeMailHtml` — and
 * that call is the *only* thing standing between a stranger's markup and this
 * document. `dangerouslySetInnerHTML` here is deliberate and must never be fed
 * anything that has not come back from the sanitizer.
 *
 * Remote content is blocked until the user asks for it, per message, which is
 * what every mail client does and for the same reason: an image fetched from a
 * sender's server is a read receipt they did not ask permission for.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ExternalLink, ImageOff, Link2, Mail, RefreshCw, Reply, Search } from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Button, Input, Tooltip } from '@/primitives'
import { sanitizeMailHtml } from '../../lib/mail-html'
import { trpc } from '../../lib/trpc'
import { activeRemoteAtom } from '../../state/vaults'
import { openNoteTabAtom } from '../../state/panes'

interface ThreadSummary {
  id: string
  subject: string
  from: string
  date: string
  snippet: string
  unread: boolean
  messageCount: number
  webUrl: string
}

interface ThreadMessage {
  id: string
  from: string
  to: string[]
  date: string
  /** Plain text — the fallback, and what a text-only message carries. */
  body: string
  /** Raw, unsanitized HTML, or null. Only `MessageBody` may touch this. */
  html: string | null
}

interface Thread {
  id: string
  subject: string
  webUrl: string
  messages: ThreadMessage[]
}

type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; threads: ThreadSummary[] }
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
  const remote = useAtomValue(activeRemoteAtom)
  const openNote = useSetAtom(openNoteTabAtom)

  const load = useCallback(() => {
    setList({ kind: 'loading' })
    void trpc.google.threads
      .query({ query: submitted })
      .then((threads) => setList({ kind: 'ready', threads }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Could not load your mail.'
        setList(NOT_CONNECTED.test(message) ? { kind: 'disconnected' } : { kind: 'error', message })
      })
  }, [submitted])

  useEffect(load, [load])

  const openThread = (id: string) => {
    setOpenId(id)
    setOpen(null)
    void trpc.google.thread.query({ id }).then(setOpen).catch(() => setOpenId(null))
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
    <div className="flex h-full min-h-0">
      {/* The list */}
      <div className="flex min-h-0 w-80 shrink-0 flex-col border-r border-border">
        <div className="flex h-11 shrink-0 items-center gap-1 px-2">
          <h2 className="flex items-center gap-2 px-1 text-sm font-medium">
            <Mail size={15} />
            Mail
          </h2>
          <Tooltip content="refresh">
            <Button variant="ghost" size="icon-xs" className="ml-auto" aria-label="refresh mail" onClick={load}>
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
          {list.kind === 'ready' && list.threads.length === 0 && <Note>No threads.</Note>}
          {list.kind === 'ready' &&
            list.threads.map((thread) => (
              <Button
                key={thread.id}
                variant="ghost"
                onClick={() => openThread(thread.id)}
                className={`block h-auto w-full rounded-none border-b border-border/50 px-3 py-2 text-left ${
                  openId === thread.id ? 'bg-secondary' : ''
                }`}
              >
                <span className="flex items-baseline justify-between gap-2">
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
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {shortDate(thread.date)}
                  </span>
                </span>
                <span
                  className={`block truncate text-xs ${thread.unread ? 'font-medium' : ''}`}
                >
                  {thread.subject}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {thread.snippet}
                </span>
              </Button>
            ))}
        </div>
      </div>

      {/* The reader */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
                <article key={message.id} className="border-b border-border/50 py-3 last:border-0">
                  <header className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                    <span className="min-w-0 truncate font-medium">{message.from}</span>
                    <span className="shrink-0 text-muted-foreground">{shortDate(message.date)}</span>
                  </header>
                  {message.to.length > 0 && (
                    <p className="mb-2 truncate text-[11px] text-muted-foreground">
                      to {message.to.join(', ')}
                    </p>
                  )}
                  <MessageBody message={message} />
                </article>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="p-6 text-center text-sm text-muted-foreground">{children}</p>
}

/** Schemes a mail link may open. Anything else — `file:`, and whatever a sender
 *  invents — is dropped rather than handed to the OS. DOMPurify has already
 *  refused `javascript:`; this is the second gate, at the point of action. */
const OPENABLE = /^(https?|mailto):/i

/**
 * One message's body: sanitized HTML when there is any, text otherwise.
 *
 * "Load images" is per message and lives here rather than on the thread, which
 * matches how the decision is actually made — a user trusts *this* newsletter,
 * not everything the thread ever collected. Re-sanitizing from the original
 * HTML on unblock (rather than stashing the stripped URLs and putting them
 * back) keeps one code path: whatever renders has been through the sanitizer
 * with the current setting, always.
 */
function MessageBody({ message }: { message: ThreadMessage }) {
  const [allowRemoteContent, setAllowRemoteContent] = useState(false)
  const sanitized = useMemo(
    () => (message.html === null ? null : sanitizeMailHtml(message.html, { allowRemoteContent })),
    [message.html, allowRemoteContent],
  )

  if (sanitized === null) {
    return <p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>
  }

  /**
   * Links inside a message must not navigate anything — an in-place navigation
   * would replace the app itself, and `target=_blank` would open a Chromium
   * window with no address bar. Delegated from the container so it covers every
   * anchor in markup we do not control.
   */
  const openLink = (event: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest('a[href]')
    if (anchor === null) return
    // Prevent first, decide second: an untrusted scheme must still not navigate.
    event.preventDefault()
    const href = anchor.getAttribute('href') ?? ''
    if (OPENABLE.test(href)) void window.holi.openExternal(href)
  }

  return (
    <>
      {sanitized.blockedRemoteCount > 0 && (
        <div className="mb-2 flex items-center gap-2 rounded-md bg-secondary px-2 py-1 text-[11px] text-muted-foreground">
          <ImageOff size={12} className="shrink-0" />
          <span className="min-w-0 flex-1">
            Images blocked — loading them tells the sender you opened this.
          </span>
          <Button variant="ghost" size="xs" onClick={() => setAllowRemoteContent(true)}>
            Load images
          </Button>
        </div>
      )}
      {/* The one dangerouslySetInnerHTML in the app. `sanitized.html` is the
          sanitizer's output and nothing else may be substituted here. */}
      <div
        className="mail-body text-sm"
        onClick={openLink}
        dangerouslySetInnerHTML={{ __html: sanitized.html }}
      />
    </>
  )
}
