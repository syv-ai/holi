/**
 * Whether the assistant that writes a meeting's topics can take a request
 * now (Summarise now), and when it cannot, why and what gets it going again:
 * waiting for it to start, its session (where it waits for the person), a new
 * one (`meeting.scribe.restart`), or the agent setting when the vault's agent
 * cannot run it.
 */
import { useAtomValue } from 'jotai'
import { agentSessionRowsAtom } from '@/plugin-api'
import type { MeetingState, ScribeState } from '../shared/meeting'
import { useAgentName } from './agent-name'
import { SCRIBE_TITLE } from './names'

type ScribeFix = 'open-session' | 'restart' | 'settings'

export type ScribeReadiness = { ready: true } | { ready: false; reason: string; fixes: ScribeFix[] }

/** The scribe's state, its session's row given: the agent's own word that it
 *  waits for the person is fresher than the last meeting event. */
export function scribeStateOf(
  meeting: MeetingState,
  row: { state: string } | undefined,
): ScribeState {
  return row?.state === 'needs-you' ? 'needs-you' : meeting.scribeState
}

/** Why the topics cannot run under this vault's agent. */
export const unsupportedReason = (agent: string): string =>
  `Topics need Claude Code or Pi, and this vault’s agent is ${agent}.`

export function useScribeReadiness(meeting: MeetingState): ScribeReadiness {
  const rows = useAtomValue(agentSessionRowsAtom)
  const agent = useAgentName()
  const session = meeting.scribeSessionId
  const state = scribeStateOf(
    meeting,
    rows.find((r) => r.id === session),
  )
  const withSession = (fixes: ScribeFix[]): ScribeFix[] =>
    session === undefined ? fixes : [...fixes, 'open-session']
  if (meeting.scribeUnsupported !== undefined) {
    return {
      ready: false,
      reason: `${unsupportedReason(agent)} Choose one in Settings › General › Agents, then start the assistant.`,
      fixes: ['settings', 'restart'],
    }
  }
  if (meeting.scribeUnreachable === true) {
    return {
      ready: false,
      reason: `${SCRIBE_TITLE} isn’t receiving the transcript yet.`,
      fixes: withSession([]),
    }
  }
  switch (state) {
    case 'idle':
    case 'working':
      return { ready: true }
    case 'starting':
      return { ready: false, reason: `${SCRIBE_TITLE} is starting.`, fixes: [] }
    case 'needs-you':
      return {
        ready: false,
        reason: `${SCRIBE_TITLE} is waiting for you in its session.`,
        fixes: withSession([]),
      }
    case 'gone':
      return {
        ready: false,
        reason: `${SCRIBE_TITLE} stopped. Recording and captions go on.`,
        fixes: withSession(['restart']),
      }
    case 'off':
      return {
        ready: false,
        reason: `${SCRIBE_TITLE} didn’t start. Recording and captions go on.`,
        fixes: ['restart'],
      }
  }
}
