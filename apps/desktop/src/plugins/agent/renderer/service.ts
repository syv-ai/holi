/**
 * The agent service this plugin provides (`AgentServiceSource`): what every
 * "Ask" outside the plugin goes through, bound to the store by core's
 * `useAgentService()`; and, for a plugin whose runs are agent sessions (a
 * Holi's), showing one and what it changed.
 */
import { atom } from 'jotai'
import type { AgentServiceSource } from '@/plugin-api'
import {
  keepRunAtom,
  loadRunChangesAtom,
  reviewRunAtom,
  revertRunAtom,
  runFilesAtom,
  runsReviewedAtom,
} from './state/runs'
import { agentSessionsAtom, askTargetsAtom, defaultAgentTargetAtom } from './state/sessions'
import { sendToAgentAtom, startSessionAtom } from './state/send'
import { showSessionAtom } from './state/session-view'

export const AGENT_SERVICE: AgentServiceSource = {
  name: 'Claude',
  sessions: agentSessionsAtom,
  targets: atom((get) => ({
    sessions: get(askTargetsAtom),
    default: get(defaultAgentTargetAtom),
  })),
  ask: sendToAgentAtom,
  start: startSessionAtom,
  show: showSessionAtom,
  runs: {
    files: runFilesAtom,
    reviewed: runsReviewedAtom,
    load: loadRunChangesAtom,
    review: reviewRunAtom,
    keep: keepRunAtom,
    revert: revertRunAtom,
  },
}
