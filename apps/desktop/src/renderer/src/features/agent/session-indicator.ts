/**
 * A session's status orb, the one rule for it: the chats section in the nav
 * and the rail that stands in for the nav while it is hidden both draw a
 * session through this, so the two can never disagree about what orange means.
 */
import { useAtomValue } from 'jotai'
import { useCallback } from 'react'
import { agentIndicator, agentThemeNote, type AgentIndicator } from '@/lib/agent-notices'
import { agentModeAtSpawnAtom, type AgentSession } from '@/state/agent'
import { activeModeAtom } from '@/state/color-scheme'

export function useSessionIndicator(): (session: AgentSession) => AgentIndicator {
  const modeAtSpawn = useAtomValue(agentModeAtSpawnAtom)
  const mode = useAtomValue(activeModeAtom)
  return useCallback(
    (session: AgentSession) =>
      agentIndicator({
        ...session,
        themeNote: agentThemeNote({
          running: !session.exited,
          modeAtSpawn: modeAtSpawn[session.id] ?? null,
          mode,
        }),
      }),
    [modeAtSpawn, mode],
  )
}
