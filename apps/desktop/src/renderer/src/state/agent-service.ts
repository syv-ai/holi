/**
 * The vault's agent, for everything outside the plugin that provides it
 * (docs/features/agent-sessions.md): null while no running plugin does, so
 * every "Ask" gates on it.
 */
import { useAtomValue, useStore } from 'jotai'
import { useMemo } from 'react'
import type { AgentService } from '@/plugin-api/types'
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
