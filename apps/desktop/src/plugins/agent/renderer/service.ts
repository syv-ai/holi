/**
 * The agent service this plugin provides (`AgentServiceSource`): what every
 * "Ask" outside the plugin goes through, bound to the store by core's
 * `useAgentService()`.
 */
import { atom } from 'jotai'
import type { AgentServiceSource } from '@/plugin-api'
import { agentSessionsAtom, askTargetsAtom, defaultAgentTargetAtom } from './state/sessions'
import { sendToAgentAtom, startSessionAtom } from './state/send'

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
