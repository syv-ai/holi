/**
 * The agent interface's main side: nothing but its name. Its sessions, turns
 * and terminals are the agent plugin's, and it reaches them as the agent's
 * renderer does (docs/features/agent-sessions.md).
 */
import type { MainPlugin } from '../../../main/plugin-api'
import { AGENT_UI_INFO } from '../info'

export const agentUiMain: MainPlugin = { info: AGENT_UI_INFO }
