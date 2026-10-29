/**
 * The agent's capabilities, as the renderer calls them: the sessions'
 * (`main/host/capabilities.ts`) and the inbox's (`main/inbox/capabilities.ts`),
 * one namespace. One client, so a test fakes
 * the agent by mocking this module.
 */
import { capClient } from '@/plugin-api'
import type { agentCapabilities } from '../main/host/capabilities'
import type { inboxCapabilities } from '../main/inbox/capabilities'

export const agentCap = capClient<
  ReturnType<typeof agentCapabilities> & ReturnType<typeof inboxCapabilities>
>('agent')
