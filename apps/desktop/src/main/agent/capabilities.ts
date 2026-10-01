/**
 * The agent's capabilities: which sessions this vault has running.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { noParams } from '../capabilities/params'
import { cap } from '../capabilities/registry'
import type { SessionSummary } from './claude-sessions'

export const AGENT_NAMESPACES = ['agent'] as const

export interface AgentCapabilitiesDeps {
  /** The vault's sessions; empty when it is not the one open. */
  sessionsFor(remote: string): SessionSummary[]
}

export const agentCapabilities = (deps: AgentCapabilitiesDeps) => ({
  'agent.sessions': cap({
    doors: ['app', 'cli'],
    params: noParams,
    run: async (ctx): Promise<SessionSummary[]> => deps.sessionsFor(ctx.remote),
    text: (sessions) => sessions.map((s) => `${s.state}\t${s.name}`).join('\n'),
  }),
})
