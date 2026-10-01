/**
 * The agent's capabilities, as the renderer calls them (`plugins/agent/main/host/capabilities.ts`).
 * One client, so a test fakes the agent by mocking this module.
 */
// eslint-disable-next-line no-restricted-imports -- the agent's renderer is still core here
import type { agentCapabilities } from '../../../plugins/agent/main/host/capabilities'
import { capClient } from './cap-client'

export const agentCap = capClient<ReturnType<typeof agentCapabilities>>('agent')
