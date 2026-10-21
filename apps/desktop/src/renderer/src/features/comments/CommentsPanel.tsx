/**
 * The focused note's comment threads, as a right-hand drawer beside the
 * editor (docs/features/note-comments.md).
 *
 * A thread is the passage it is about, its comments oldest first, and a reply
 * field; Resolve puts it under the Resolved filter. Picking a thread marks its
 * passage in the editor and scrolls to it. A thread whose passage is gone is
 * detached: listed with its quote, never dropped. A new thread starts from a
 * selection (the selection's Comment, or the palette's Comment on selection)
 * and opens here on its composer.
 *
 * The drawer shares the right edge with History: opening this one closes
 * History, and History opening hides this one.
 */
import { commentByline, isResolved, type CommentThread } from '@holi/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { useState } from 'react'
import { DrawerShell, DrawerTitle } from '@/composites'
import { Button, PillGroup, Textarea } from '@/primitives'
import { cn } from '@/lib/cn'
import {
  activeThreadAtom,
  addCommentAtom,
  commentDraftAtom,
  commentsOpenAtom,
  commentsTargetPathAtom,
  focusThreadAtom,
  replyCommentAtom,
  resolveThreadAtom,
  targetThreadsAtom,
  threadLinesAtom,
  toggleCommentsAtom,
} from '@/state/comments'
import { historyOpenAtom } from '@/state/history'

/** `at` is an ISO string. */
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

type Filter = 'open' | 'resolved'

const FILTERS = [
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
] as const

/** A comment field that sends on ⌘↵, and its send and cancel. */
function Composer({
  label,
  placeholder,
  send,
  onSend,
  onCancel,
  autoFocus = false,
}: {
  label: string
  placeholder: string
  send: string
  onSend: (body: string) => Promise<void>
  onCancel?: () => void
  autoFocus?: boolean
}) {
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (body.trim() === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSend(body)
      setBody('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-2">
      <Textarea
        aria-label={label}
        placeholder={placeholder}
        value={body}
        autoFocus={autoFocus}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void submit()
          }
          if (e.key === 'Escape' && onCancel) {
            e.preventDefault()
            onCancel()
          }
        }}
        className="min-h-12 text-[13px]"
      />
      {error !== null && <p className="text-[12px] text-destructive">{error}</p>}
      <div className="flex justify-end gap-1">
        {onCancel && (
          <Button variant="ghost" size="xs" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button size="xs" disabled={busy || body.trim() === ''} onClick={() => void submit()}>
          {send}
        </Button>
      </div>
    </div>
  )
}

/** The passage, quoted: what the thread is about. */
function Quote({ text }: { text: string }) {
  return (
    <p className="line-clamp-2 text-[12px] break-words text-muted-foreground">
      &ldquo;{text.replace(/\s+/g, ' ').trim()}&rdquo;
    </p>
  )
}

function Thread({
  path,
  thread,
  line,
  active,
}: {
  path: string
  thread: CommentThread
  /** Where it is in the buffer now; null while detached, undefined before the
   *  editor has said. */
  line: number | null | undefined
  active: boolean
}) {
  const focus = useSetAtom(focusThreadAtom)
  const reply = useSetAtom(replyCommentAtom)
  const resolve = useSetAtom(resolveThreadAtom)
  const [replying, setReplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const resolved = isResolved(thread)

  const toggleResolved = async () => {
    setError(null)
    try {
      await resolve({ path, thread: thread.id, resolved: !resolved })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <li
      data-thread={thread.id}
      className={cn('grid gap-2 rounded-lg px-3 py-2.5', active && 'bg-accent')}
    >
      <Button
        variant="ghost"
        onClick={() => focus({ path, id: thread.id })}
        className="h-auto w-full min-w-0 flex-col items-start gap-0.5 rounded-md px-0 py-0 text-left font-normal whitespace-normal hover:bg-transparent"
      >
        <Quote text={thread.anchor.quote} />
        <span className="text-[11px] text-muted-foreground">
          {line === null
            ? 'Detached: the passage is gone'
            : line === undefined
              ? ''
              : `Line ${line}`}
        </span>
      </Button>

      {thread.comments.map((c) => (
        <div key={c.id} className="grid gap-0.5">
          <p className="text-[11px] text-muted-foreground">
            <span className="text-foreground">{commentByline(c)}</span> · {when(c.at)}
          </p>
          <p className="text-[13px] break-words whitespace-pre-wrap text-foreground">{c.body}</p>
        </div>
      ))}

      {thread.status !== null && (
        <p className="text-[11px] text-muted-foreground">
          {thread.status.resolved ? 'Resolved' : 'Reopened'} by {thread.status.by} ·{' '}
          {when(thread.status.at)}
        </p>
      )}

      {replying ? (
        <Composer
          label="Reply"
          placeholder="Reply, ⌘↵ to send"
          send="Reply"
          autoFocus
          onSend={async (body) => {
            await reply({ path, thread: thread.id, body })
            setReplying(false)
          }}
          onCancel={() => setReplying(false)}
        />
      ) : (
        <div className="flex gap-1">
          {!resolved && (
            <Button variant="ghost" size="xs" onClick={() => setReplying(true)}>
              Reply
            </Button>
          )}
          <Button variant="ghost" size="xs" onClick={() => void toggleResolved()}>
            {resolved ? 'Reopen' : 'Resolve'}
          </Button>
        </div>
      )}
      {error !== null && <p className="text-[12px] text-destructive">{error}</p>}
    </li>
  )
}

export function CommentsPanel() {
  const open = useAtomValue(commentsOpenAtom)
  const historyOpen = useAtomValue(historyOpenAtom)
  const path = useAtomValue(commentsTargetPathAtom)
  const threads = useAtomValue(targetThreadsAtom)
  const lines = useAtomValue(threadLinesAtom)
  const draft = useAtomValue(commentDraftAtom)
  const active = useAtomValue(activeThreadAtom)
  const setDraft = useSetAtom(commentDraftAtom)
  const add = useSetAtom(addCommentAtom)
  const toggle = useSetAtom(toggleCommentsAtom)
  const [filter, setFilter] = useState<Filter>('open')

  const openCount = threads.filter((t) => !isResolved(t)).length
  const shown = threads.filter((t) => isResolved(t) === (filter === 'resolved'))
  const here = path === null ? {} : (lines[path] ?? {})
  const drafting = draft !== null && draft.path === path

  return (
    <DrawerShell
      id="comments"
      side="right"
      open={open && !historyOpen && path !== null}
      label="Comments"
      header={<DrawerTitle title="Comments" subtitle={path ?? undefined} />}
      aside={threads.length === 0 ? undefined : `${openCount} open`}
      onClose={() => toggle(false)}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 px-3 pt-2">
          <PillGroup<Filter>
            label="Which threads"
            options={FILTERS}
            isOn={(v) => v === filter}
            onPick={setFilter}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {drafting && path !== null && (
            <div className="mb-2 grid gap-2 rounded-lg bg-accent px-3 py-2.5">
              <Quote text={draft.anchor.quote} />
              <Composer
                key={`${draft.anchor.line}:${draft.anchor.quote}`}
                label="New comment"
                placeholder="Comment, ⌘↵ to send. @login mentions a teammate."
                send="Comment"
                autoFocus
                onSend={async (body) => {
                  await add(body)
                  setFilter('open')
                }}
                onCancel={() => setDraft(null)}
              />
            </div>
          )}

          {shown.length === 0 && !drafting ? (
            <p className="px-3 py-1.5 text-[13px] text-muted-foreground">
              {filter === 'open'
                ? 'No open comments. Select text in the note and choose Comment to start one.'
                : 'No resolved comments.'}
            </p>
          ) : (
            <ul className="grid gap-1">
              {shown.map((t) => (
                <Thread
                  key={t.id}
                  path={path!}
                  thread={t}
                  line={here[t.id]}
                  active={active?.path === path && active.id === t.id}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </DrawerShell>
  )
}
