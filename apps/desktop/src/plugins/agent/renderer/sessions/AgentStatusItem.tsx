import { useAtomValue, useSetAtom } from "jotai"
import { BotIcon } from "lucide-react"

import { appModeAtom, StatusBarItem } from "@/plugin-api"
import { agentsStatusAtom } from "../state/agents-status"
import { agentSessionsAtom } from "../state/sessions"

/**
 * The agent's item in the status bar (docs/features/status-bar.md): how many
 * sessions are working or waiting on you, from the same counts the mode
 * toggle reports. Nothing while no session is live. A click opens Agents.
 */
export function agentStatusText(
  sessions: number,
  status: { needsYou: number; working: number }
): string | null {
  if (status.needsYou > 0)
    return `${status.needsYou} need${status.needsYou === 1 ? "s" : ""} you`
  if (status.working > 0) return `${status.working} working`
  if (sessions > 0) return `${sessions} session${sessions === 1 ? "" : "s"}`
  return null
}

export function AgentStatusItem() {
  const sessions = useAtomValue(agentSessionsAtom)
  const status = useAtomValue(agentsStatusAtom)
  const setMode = useSetAtom(appModeAtom)
  const text = agentStatusText(sessions.length, status)
  if (text === null) return null
  return (
    <StatusBarItem
      tooltip={`Claude Code: ${text}. Click to open Agents`}
      onClick={() => setMode("agents")}
    >
      <BotIcon aria-hidden />
      {text}
    </StatusBarItem>
  )
}
