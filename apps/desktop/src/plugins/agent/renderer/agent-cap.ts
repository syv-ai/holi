/**
 * The agent's capabilities, as the renderer calls them (`main/host/capabilities.ts`).
 * One client, so a test fakes the agent by mocking this module.
 */
import { capClient } from '@/plugin-api'
import type { agentCapabilities } from '../main/host/capabilities'

/** One thing in a session's conversation, as main reads it for the chat. */
export type { ChatEntry } from '../main/claude/transcript'

export const agentCap = capClient<ReturnType<typeof agentCapabilities>>('agent')
