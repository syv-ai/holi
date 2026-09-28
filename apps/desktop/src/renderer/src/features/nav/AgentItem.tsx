/**
 * The vault's assistant as one of the nav menu's items (D110): Claude Code's
 * agent list, where sessions are started and picked up, in a tab of its own.
 *
 * Green while any of the vault's sessions is running, the menu's grey
 * otherwise. The rows under the file tree say which and how; this says only
 * that something is.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Bot } from 'lucide-react'
import { useMemo } from 'react'
import type { MorphingMenuItem } from '@/primitives'
import { agentSessionsAtom } from '@/state/agent'
import { showAgentsAtom } from '@/state/agent-send'

/** The nav menu's agent item, rebuilt only when "any running" flips. */
export function useAgentItem(): MorphingMenuItem {
  const running = useAtomValue(agentSessionsAtom).length > 0
  const showAgents = useSetAtom(showAgentsAtom)
  return useMemo(
    () => ({
      id: 'agent',
      label: running ? 'Agents: running' : 'Agents',
      icon: Bot,
      ...(running ? { tone: 'live' as const } : {}),
      onSelect: () => void showAgents(),
    }),
    [running, showAgents],
  )
}
