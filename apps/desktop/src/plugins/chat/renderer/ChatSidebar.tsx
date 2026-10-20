/**
 * The chat rows the chat plugin adds to the Agents sidebar (its slot,
 * docs/features/chat.md): New chat, then every chat grouped by what it needs
 * from you, with Archived folded at the end.
 *
 * The rows are after MonoCode's sidebar (MIT, Copyright (c) 2026 Nick; see
 * NOTICE.md): a title, and under it the state in words with its own motion,
 * the lines a finished turn changed, and the step in flight.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { ChevronRight, MessageSquarePlus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { SectionLabel } from '@/composites'
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  Icon,
} from '@/primitives'
import { cn } from '@/plugin-api'
import type { ChatSummary } from '../shared/chat'
import { ago, Churn, StateLabel } from './parts'
import {
  chatViewAtom,
  chatsAtom,
  chatsLoadedAtom,
  newChatViewAtom,
  sidebarChatsAtom,
  updateChatAtom,
} from './state/chats'
import { churnAtom } from './state/review'

const ROW =
  'h-7 w-full min-w-0 justify-start gap-2 rounded-lg px-2 text-nav font-medium text-muted-foreground motion-respond hover:bg-foreground/[0.04] hover:text-foreground active:bg-foreground/[0.07] aria-[current=page]:bg-foreground/[0.06] aria-[current=page]:text-foreground'

const CHAT_ROW =
  'h-auto w-full min-w-0 flex-col items-stretch gap-0.5 rounded-lg px-2 py-1.5 text-start font-normal motion-respond hover:bg-foreground/[0.04] active:bg-foreground/[0.07] aria-[current=page]:bg-foreground/[0.06]'

/** "now" that moves, so the rows' times stay true. */
function useNow(stepMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), stepMs)
    return () => window.clearInterval(id)
  }, [stepMs])
  return now
}

function ChatRow({ chat, now }: { chat: ChatSummary; now: number }): React.JSX.Element {
  const view = useAtomValue(chatViewAtom)
  const setView = useSetAtom(chatViewAtom)
  const update = useSetAtom(updateChatAtom)
  const churn = useAtomValue(churnAtom)[chat.id]
  const current = view.kind === 'chat' && view.id === chat.id
  const state =
    chat.state === 'needs-you'
      ? 'needs-you'
      : chat.state === 'working'
        ? 'working'
        : chat.endedAt !== undefined && !chat.reviewed
          ? 'done'
          : 'idle'
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Button
          variant="ghost"
          className={CHAT_ROW}
          aria-current={current ? 'page' : undefined}
          data-chat-row={chat.id}
          data-state={state}
          onClick={() => setView({ kind: 'chat', id: chat.id })}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-nav font-medium',
                current ? 'text-foreground' : 'text-foreground/85',
              )}
            >
              {chat.title}
            </span>
            {state !== 'working' && (
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {ago(chat.state === 'needs-you' ? now : (chat.endedAt ?? chat.updatedAt), now)}
              </span>
            )}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <StateLabel state={state} />
            {state === 'done' && churn !== undefined && churn.files.length > 0 && (
              <Churn added={churn.added} removed={churn.removed} />
            )}
            {state === 'working' && chat.step !== undefined && (
              <span className="min-w-0 truncate">{chat.step}</span>
            )}
            {state === 'idle' && <span>Chat</span>}
          </span>
        </Button>
      </ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
        <ContextMenuItem onSelect={() => void update({ id: chat.id, archived: !chat.archived })}>
          {chat.archived ? 'Unarchive' : 'Archive'}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function ChatSidebar(): React.JSX.Element {
  const chats = useAtomValue(sidebarChatsAtom)
  const all = useAtomValue(chatsAtom)
  const loaded = useAtomValue(chatsLoadedAtom)
  const view = useAtomValue(chatViewAtom)
  const newChat = useSetAtom(newChatViewAtom)
  const [showArchived, setShowArchived] = useState(false)
  const now = useNow()
  const archived = all.filter((c) => c.archived)

  return (
    <section aria-label="Chats" className="flex flex-col gap-px" data-chat-sidebar="">
      <SectionLabel className="flex items-center gap-1.5">
        Chats
        <span className="tabular-nums text-muted-foreground">{chats.length}</span>
      </SectionLabel>
      <Button
        variant="ghost"
        className={ROW}
        aria-current={view.kind === 'new' ? 'page' : undefined}
        onClick={() => newChat()}
      >
        <Icon icon={MessageSquarePlus} size="sm" />
        <span className="min-w-0 flex-1 truncate text-start">New chat</span>
      </Button>
      {!loaded ? (
        <div role="status" aria-label="Loading chats" className="flex flex-col gap-1.5 px-2 pt-1">
          <div className="h-9 rounded-lg motion-shimmer" />
          <div className="h-9 rounded-lg motion-shimmer" />
        </div>
      ) : (
        chats.map((c) => <ChatRow key={c.id} chat={c} now={now} />)
      )}
      {archived.length > 0 && (
        <div className="flex flex-col gap-px pt-1">
          <Button
            variant="ghost"
            className={cn(ROW, 'font-normal')}
            aria-expanded={showArchived}
            onClick={() => setShowArchived((v) => !v)}
          >
            <Icon
              icon={ChevronRight}
              size="sm"
              className={cn('motion-respond', showArchived && 'rotate-90')}
            />
            <span className="flex-1 text-start">Archived</span>
            <span className="text-xs tabular-nums text-muted-foreground">{archived.length}</span>
          </Button>
          {showArchived && archived.map((c) => <ChatRow key={c.id} chat={c} now={now} />)}
        </div>
      )}
    </section>
  )
}
