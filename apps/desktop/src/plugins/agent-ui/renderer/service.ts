/**
 * The agent service this plugin provides (`AgentServiceSource`): what every
 * "Ask" outside the plugin goes through, bound to the store by core's
 * `useAgentService()`.
 */
import { atom } from 'jotai'
import type { AgentServiceSource } from '@/plugin-api'
import { agentSessionsAtom, askTargetsAtom } from '../../agent/renderer/public'
import { sendToAgentAtom, startSessionAtom } from './state/actions'
import { defaultAgentTargetAtom } from './state/page'

export const AGENT_SERVICE: AgentServiceSource = {
  name: 'Claude',
  sessions: agentSessionsAtom,
  targets: atom((get) => ({
    sessions: get(askTargetsAtom),
    default: get(defaultAgentTargetAtom),
  })),
  ask: sendToAgentAtom,
  start: startSessionAtom,
}
