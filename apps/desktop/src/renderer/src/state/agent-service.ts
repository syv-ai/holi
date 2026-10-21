/**
 * The vault's agent, for everything outside the plugin that provides it
 * (docs/features/agent-sessions.md): null while no running plugin does, so
 * every "Ask" gates on it.
 */
import { atom, useAtomValue, useStore } from 'jotai'
import { useMemo } from 'react'
import type { AskAgentSeam } from '@/editor/askAgent'
import type { AgentRunFile, AgentService, AgentSessionRow, AskResult } from '@/plugin-api/types'
import { agentSourceAtom } from './plugins'

export function useAgentService(): AgentService | null {
  const source = useAtomValue(agentSourceAtom)
  const store = useStore()
  return useMemo(
    () =>
      source === null
        ? null
        : {
            name: source.name,
            sessions: source.sessions,
            targets: source.targets,
            ask: (args) => store.set(source.ask, args),
            start: (args) => store.set(source.start, args),
          },
    [source, store],
  )
}

/** Show a session in the Agents view, brought back first if it finished. */
export const showAgentSessionAtom = atom(
  null,
  (get, set, args: { session: string; live: boolean }): Promise<AskResult> => {
    const source = get(agentSourceAtom)
    return source === null ? Promise.resolve(NO_AGENT) : set(source.show, args)
  },
)

const NO_FILES: Readonly<Record<string, readonly AgentRunFile[]>> = {}
const NO_REVIEWS: Readonly<Record<string, 'kept' | 'reverted'>> = {}

/** What each run changed, by job id (`AgentRunsSource`); empty with no agent. */
export const agentRunFilesAtom = atom((get) => {
  const source = get(agentSourceAtom)
  return source === null ? NO_FILES : get(source.runs.files)
})

/** Runs kept or reverted here, by job id; empty with no agent. */
export const agentRunsReviewedAtom = atom((get) => {
  const source = get(agentSourceAtom)
  return source === null ? NO_REVIEWS : get(source.runs.reviewed)
})

export const loadAgentRunsAtom = atom(null, (get, set, ids: readonly string[]) => {
  const source = get(agentSourceAtom)
  return source === null ? Promise.resolve() : set(source.runs.load, ids)
})

export const reviewAgentRunAtom = atom(null, (get, set, id: string) => {
  const source = get(agentSourceAtom)
  if (source !== null) set(source.runs.review, id)
})

export const keepAgentRunAtom = atom(null, (get, set, id: string) => {
  const source = get(agentSourceAtom)
  if (source !== null) set(source.runs.keep, id)
})

export const revertAgentRunAtom = atom(null, (get, set, id: string): Promise<AskResult> => {
  const source = get(agentSourceAtom)
  return source === null ? Promise.resolve(NO_AGENT) : set(source.runs.revert, id)
})

/** The agent's live sessions, for an atom that cannot call a hook; empty with
 *  no agent. */
export const agentSessionRowsAtom = atom((get): readonly AgentSessionRow[] => {
  const source = get(agentSourceAtom)
  return source === null ? [] : get(source.sessions)
})

/**
 * The editors' "Ask agent" seam over the service, or null with no agent, in
 * which case an editor leaves the button out. The targets are read when the
 * popover opens, since sessions come and go.
 */
export function useAskAgentSeam(): AskAgentSeam | null {
  const service = useAgentService()
  const store = useStore()
  return useMemo(
    () =>
      service === null
        ? null
        : {
            targets: () => {
              const targets = store.get(service.targets)
              return { sessions: [...targets.sessions], initial: targets.default }
            },
            onAsk: (prompt, target) => service.ask({ text: prompt, target }),
          },
    [service, store],
  )
}

/** For an editor built once: the seam it was built with may outlive the
 *  agent, and then an ask says so. */
export const NO_AGENT = { ok: false, message: 'No agent is running in this vault.' } as const
