/**
 * The agent's capabilities, as the renderer calls them (`main/host/capabilities.ts`).
 * One client, so a test fakes the agent by mocking this module.
 */
import { capClient } from '@/plugin-api'
import type { agentCapabilities } from '../main/host/capabilities'

export const agentCap = capClient<ReturnType<typeof agentCapabilities>>('agent')
