/**
 * The agent's capabilities, as the renderer calls them (`main/host/capabilities.ts`).
 * One client, so a test fakes the agent by mocking this module.
 */
import { capClient } from '@/plugin-api'
import type { agentCapabilities } from '../main/host/capabilities'

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

export const agentCap = capClient<ReturnType<typeof agentCapabilities>>('agent')
