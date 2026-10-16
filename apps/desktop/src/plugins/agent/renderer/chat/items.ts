/**
 * What the chat draws (docs/features/agent-sessions.md, The chat): the entries
 * of a conversation with each tool's result folded into its call. Types only;
 * the folding is `use-transcript.ts`. A row component takes an item and the
 * conversation's context, and nothing else.
 */
import type { ChatEntry, ImageRef, Plain } from '../agent-cap'

export type { ChatEntry, ImageRef, Plain }

type Of<K extends ChatEntry['kind']> = Extract<ChatEntry, { kind: K }>

export type ToolResult = Omit<Of<'tool-result'>, 'kind' | 'id'>

/** Where a call stands: no result yet, finished, failed, or refused by the
 *  person (a rejected permission, an interrupt during it). */
export type ToolState = 'pending' | 'done' | 'error' | 'rejected'

export type ToolItem = Omit<Of<'tool'>, 'kind'> & {
  kind: 'tool'
  result?: ToolResult
  state: ToolState
  /** Its result is here but its call is in an earlier part not yet loaded. */
  orphan?: boolean
  /** A background task it started reported (`task-note` joined by tool id). */
  note?: Of<'task-note'>
}

export type ChatItem =
  | Of<'user'>
  | Of<'assistant'>
  | Of<'thinking'>
  | ToolItem
  | Of<'command'>
  | Of<'shell'>
  | Of<'interrupt'>
  | Of<'notice'>
  | Of<'compaction'>
  | Of<'turn-end'>
  | Of<'task-note'>
  | Of<'unknown'>

/** A task of the agent's own list (TaskCreate/TaskUpdate), as the latest
 *  calls left it. */
export interface TaskState {
  id: string
  subject: string
  status: string
}

/** Facts about the whole conversation that one row cannot know alone. */
export interface ChatContext {
  /** The agent's task list by task id. */
  tasks: ReadonlyMap<string, TaskState>
  /** A sub-agent's conversation, read when its card is opened. */
  loadSubagent: (agentId: string) => Promise<ChatItem[] | null>
  /** The session the chat is of: sub-agent files are found by it. */
  sessionId: string
}
