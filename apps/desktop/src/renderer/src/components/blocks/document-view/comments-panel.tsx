/**
 * A note's comment threads, beside its text (docs/features/note-comments.md):
 * open and resolved, each with the passage it is about, its comments, a
 * reply and Resolve or Reopen; above them the thread being started on the
 * selection. A thread whose passage is gone from the note is detached, never
 * dropped. Pressing a thread's passage shows it in the text.
 */
import { useState } from 'react'
import {
  commentByline,
  isResolved,
  loginOf,
  type CommentAnchor,
  type CommentThread,
} from '@holi/shared'
import {
  CheckIcon,
  MessageSquarePlusIcon,
  MessagesSquareIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react'

import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/reui/alert'
import { Badge } from '@/components/reui/badge'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Item, ItemContent, ItemFooter, ItemHeader } from '@/components/ui/item'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/cn'
import type { ThreadsLoad } from '@/state/comments'
import { PersonAvatar } from '../planning/task-bits'
import { CommentField } from './comment-field'

type Shown = 'open' | 'resolved'

/** When a comment was written, to the minute. */
function when(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function Quote({ text }: { text: string }) {
  return (
    <blockquote className="text-muted-foreground border-l-2 ps-2 text-xs line-clamp-3 whitespace-pre-wrap">
      {text}
    </blockquote>
  )
}

function Comment({ comment }: { comment: CommentThread['comments'][number] }) {
  return (
    <li className="flex gap-2" data-comment={comment.id}>
      <PersonAvatar login={loginOf(comment.author)} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium">{commentByline(comment)}</span>
          <time
            dateTime={comment.at}
            className="text-muted-foreground shrink-0 text-xs tabular-nums"
          >
            {when(comment.at)}
          </time>
        </div>
        <p className="text-sm break-words whitespace-pre-wrap">{comment.body}</p>
      </div>
    </li>
  )
}

function Thread({
  thread,
  placed,
  active,
  onSelect,
  onReply,
  onResolve,
}: {
  thread: CommentThread
  placed: boolean
  active: boolean
  onSelect: () => void
  onReply: (body: string) => Promise<void>
  onResolve: (resolved: boolean) => Promise<void>
}) {
  const [replying, setReplying] = useState(false)
  const [busy, setBusy] = useState(false)
  const resolved = isResolved(thread)
  const toggle = async () => {
    setBusy(true)
    try {
      await onResolve(!resolved)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Item
      variant="outline"
      size="sm"
      data-thread={thread.id}
      data-active={active || undefined}
      className={cn('flex-col items-stretch', active && 'border-primary')}
    >
      <ItemHeader className="gap-2">
        <button
          type="button"
          onClick={onSelect}
          disabled={!placed}
          aria-label={placed ? 'Show the passage' : 'The passage is no longer in the note'}
          className="focus-visible:ring-ring/50 hover:text-foreground min-w-0 flex-1 rounded-sm text-start transition-colors outline-none focus-visible:ring-2 disabled:cursor-default"
        >
          <Quote text={thread.anchor.quote} />
        </button>
        {!placed ? (
          <Badge variant="warning-light" className="shrink-0">
            Detached
          </Badge>
        ) : null}
      </ItemHeader>
      <ItemContent className="gap-3">
        <ul className="flex flex-col gap-3">
          {thread.comments.map((comment) => (
            <Comment key={comment.id} comment={comment} />
          ))}
        </ul>
        {resolved && thread.status !== null ? (
          <p className="text-muted-foreground text-xs">Resolved by {thread.status.by}</p>
        ) : null}
        {replying ? (
          <CommentField
            label="Reply"
            placeholder="Reply…"
            submitLabel="Reply"
            autoFocus
            onSubmit={async (body) => {
              await onReply(body)
              setReplying(false)
            }}
            onCancel={() => setReplying(false)}
          />
        ) : null}
      </ItemContent>
      {!replying ? (
        <ItemFooter className="justify-end gap-1">
          {!resolved ? (
            <Button variant="ghost" size="sm" onClick={() => setReplying(true)}>
              Reply
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void toggle()}>
            {resolved ? (
              <RotateCcwIcon data-icon="inline-start" aria-hidden="true" />
            ) : (
              <CheckIcon data-icon="inline-start" aria-hidden="true" />
            )}
            {resolved ? 'Reopen' : 'Resolve'}
          </Button>
        </ItemFooter>
      ) : null}
    </Item>
  )
}

function PanelSkeleton() {
  return (
    <div className="flex flex-col gap-3" role="status" aria-label="Loading comments">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-12 w-full" />
        </div>
      ))}
    </div>
  )
}

export function CommentsPanel({
  load,
  placed,
  active,
  draft,
  onSelect,
  onDraftSubmit,
  onDraftCancel,
  onReply,
  onResolve,
  onRetry,
  onClose,
  onCommentSelection,
}: {
  load: ThreadsLoad
  /** The threads whose passage is in the text now. */
  placed: ReadonlySet<string>
  active: string | null
  /** The passage a new thread is being written on. */
  draft: CommentAnchor | null
  onSelect: (id: string) => void
  onDraftSubmit: (body: string) => Promise<void>
  onDraftCancel: () => void
  onReply: (id: string, body: string) => Promise<void>
  onResolve: (id: string, resolved: boolean) => Promise<void>
  onRetry: () => void
  onClose: () => void
  /** Start a thread on the text's selection; null with nothing selected. */
  onCommentSelection: (() => void) | null
}) {
  const [shown, setShown] = useState<Shown>('open')
  const threads = load.state === 'ready' ? load.threads : []
  const open = threads.filter((t) => !isResolved(t))
  const resolved = threads.filter((t) => isResolved(t))
  const list = shown === 'open' ? open : resolved

  return (
    <aside
      aria-label="Comments"
      data-comments-panel
      className="bg-background flex h-full w-80 shrink-0 flex-col border-l"
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <MessagesSquareIcon className="text-muted-foreground size-4" aria-hidden="true" />
        <h2 className="flex-1 text-sm font-medium">Comments</h2>
        <Button variant="ghost" size="icon-sm" aria-label="Close comments" onClick={onClose}>
          <XIcon aria-hidden="true" />
        </Button>
      </div>
      <div className="px-3 pt-3">
        <Tabs value={shown} onValueChange={(v) => setShown(v as Shown)}>
          <TabsList className="w-full">
            <TabsTrigger value="open">
              Open
              <span className="tabular-nums">{open.length}</span>
            </TabsTrigger>
            <TabsTrigger value="resolved">
              Resolved
              <span className="tabular-nums">{resolved.length}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 p-3">
          {draft !== null ? (
            <Item variant="outline" size="sm" className="flex-col items-stretch" data-comment-draft>
              <ItemHeader>
                <Quote text={draft.quote} />
              </ItemHeader>
              <ItemContent>
                <CommentField
                  label="Comment"
                  placeholder="Add a comment… @ to mention"
                  submitLabel="Comment"
                  autoFocus
                  onSubmit={onDraftSubmit}
                  onCancel={onDraftCancel}
                />
              </ItemContent>
            </Item>
          ) : null}
          {load.state === 'loading' ? (
            <PanelSkeleton />
          ) : load.state === 'error' ? (
            <Alert variant="destructive">
              <TriangleAlertIcon aria-hidden="true" />
              <AlertTitle>The comments could not be read</AlertTitle>
              <AlertDescription>{load.message}</AlertDescription>
              <AlertAction>
                <Button variant="outline" size="sm" onClick={onRetry}>
                  Retry
                </Button>
              </AlertAction>
            </Alert>
          ) : list.length === 0 && draft === null ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <MessagesSquareIcon />
                </EmptyMedia>
                <EmptyTitle>
                  {shown === 'open' ? 'No open comments' : 'Nothing resolved yet'}
                </EmptyTitle>
                <EmptyDescription>Select text in the note to comment on it.</EmptyDescription>
              </EmptyHeader>
              {shown === 'open' ? (
                <EmptyContent>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={onCommentSelection === null}
                    onClick={() => onCommentSelection?.()}
                  >
                    <MessageSquarePlusIcon data-icon="inline-start" aria-hidden="true" />
                    Comment on selection
                  </Button>
                </EmptyContent>
              ) : null}
            </Empty>
          ) : (
            list.map((thread) => (
              <Thread
                key={thread.id}
                thread={thread}
                placed={placed.has(thread.id)}
                active={thread.id === active}
                onSelect={() => onSelect(thread.id)}
                onReply={(body) => onReply(thread.id, body)}
                onResolve={(value) => onResolve(thread.id, value)}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </aside>
  )
}
