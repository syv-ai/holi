/**
 * The agent's capabilities, as the renderer calls them: the sessions'
 * (`main/host/capabilities.ts`), the inbox's (`main/inbox/capabilities.ts`)
 * and the quick agent's (`main/quick/capabilities.ts`), one namespace. One client, so a test fakes
 * the agent by mocking this module.
 */
import { capClient } from '@/plugin-api'
import type { agentCapabilities } from '../main/host/capabilities'
import type { inboxCapabilities } from '../main/inbox/capabilities'
import type { quickCapabilities } from '../main/quick/capabilities'

/** One thing in a session's conversation, as main reads it for the chat, and
 *  the chunks and reports it comes in. */
export type {
  ChatEntry,
  DriftReport,
  EarlierChunk,
  ImageRef,
  Plain,
  TranscriptChunk,
} from '../main/claude/transcript'

export const agentCap = capClient<
  ReturnType<typeof agentCapabilities> &
    ReturnType<typeof inboxCapabilities> &
    ReturnType<typeof quickCapabilities>
>('agent')
