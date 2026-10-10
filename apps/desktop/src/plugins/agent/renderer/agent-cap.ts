/**
 * The agent's capabilities, as the renderer calls them: the sessions'
 * (`main/host/capabilities.ts`) and the quick agent's
 * (`main/quick/capabilities.ts`), one namespace. One client, so a test fakes
 * the agent by mocking this module.
 */
import { capClient } from '@/plugin-api'
import type { agentCapabilities } from '../main/host/capabilities'
import type { quickCapabilities } from '../main/quick/capabilities'

export const agentCap = capClient<
  ReturnType<typeof agentCapabilities> & ReturnType<typeof quickCapabilities>
>('agent')
