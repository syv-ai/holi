/**
 * One item of the conversation, drawn by its kind (docs/features/agent-sessions.md,
 * The chat). Every row sits in its own boundary, so a row that throws shows a
 * line saying so and the rest of the chat stays. The switch is exhaustive for
 * the kinds this build knows and has a runtime default for one it does not.
 */
import { memo } from 'react'
import type { ChatContext, ChatItem } from '../../../../agent/renderer/public'
import { ChatMarkdown } from '../ChatMarkdown'
import { RowBoundary } from './RowBoundary'
import { ToolCard } from './ToolCard'
import { UserBubble } from './UserBubble'
import {
  CommandRow,
  CompactionRow,
  InterruptRow,
  NoticeRow,
  ShellRow,
  TaskNoteRow,
  ThinkingRow,
  TurnEndRow,
  unknownItemRow,
  UnknownRow,
} from './rows'
import { str } from './parts'

export interface ItemRowProps {
  item: ChatItem
  ctx: ChatContext
  /** How deep in sub-agent cards it is drawn: 0 in the chat itself. Nested rows
   *  are smaller and indented, and never take the focus. */
  depth?: number
  /** The item is the last of a turn still in progress: a thought is open. */
  live?: boolean
  /** Told the shape of an item that could not be drawn. */
  onRowError?: (shape: string) => void
}

function draw(
  item: ChatItem,
  ctx: ChatContext,
  depth: number,
  live: boolean,
): React.JSX.Element | null {
  switch (item.kind) {
    case 'user':
      return item.queued === true ? (
        <div data-chat-row="user" className="flex flex-col items-end gap-0.5">
          <UserBubble text={item.text} images={item.images} />
          <span data-chat-queued="" className="px-1 text-xs text-muted-foreground">
            queued
          </span>
        </div>
      ) : (
        <UserBubble text={item.text} images={item.images} />
      )
    case 'assistant':
      return str(item.text).trim() === '' ? null : (
        <div data-chat-row="assistant">
          <ChatMarkdown text={item.text} compact={depth > 0} />
        </div>
      )
    case 'thinking':
      return <ThinkingRow item={item} live={live} compact={depth > 0} />
    case 'tool':
      return <ToolCard item={item} ctx={ctx} />
    case 'command':
      return <CommandRow item={item} />
    case 'shell':
      return <ShellRow item={item} />
    case 'interrupt':
      return <InterruptRow item={item} />
    case 'notice':
      return <NoticeRow item={item} />
    case 'compaction':
      return <CompactionRow item={item} />
    case 'turn-end':
      return <TurnEndRow item={item} />
    case 'task-note':
      return <TaskNoteRow item={item} />
    case 'unknown':
      return <UnknownRow shape={item.shape} raw={item.raw} />
    default: {
      // A kind a newer main sends: this build draws it as unrecognised.
      const unreachable: never = item
      return unknownItemRow(unreachable)
    }
  }
}

/** Drawn inside the boundary, so reading a field of a malformed item is as
 *  safe as rendering it. */
function Body({
  item,
  ctx,
  depth,
  live,
}: {
  item: ChatItem
  ctx: ChatContext
  depth: number
  live: boolean
}): React.JSX.Element | null {
  return draw(item, ctx, depth, live)
}

function ItemRowImpl({
  item,
  ctx,
  depth = 0,
  live = false,
  onRowError,
}: ItemRowProps): React.JSX.Element {
  const row = (
    <RowBoundary item={item} scope={ctx.sessionId} onRowError={onRowError}>
      <Body item={item} ctx={ctx} depth={depth} live={live} />
    </RowBoundary>
  )
  if (depth === 0) return row
  return (
    <div data-chat-depth={depth} className="flex flex-col gap-2 pl-3 text-xs">
      {row}
    </div>
  )
}

/** Memoised on its props' identity: the reader keeps an unchanged item the
 *  same object, so a row redraws only when its item (or the conversation's
 *  context) does. */
export const ItemRow = memo(ItemRowImpl)
