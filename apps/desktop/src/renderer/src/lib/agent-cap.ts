/**
 * The agent's capabilities, as the renderer calls them (`main/agent/capabilities.ts`).
 * One client, so a test fakes the agent by mocking this module.
 */
import type { agentCapabilities } from '../../../main/agent/capabilities'
import { capClient } from './cap-client'

export const agentCap = capClient<ReturnType<typeof agentCapabilities>>('agent')
