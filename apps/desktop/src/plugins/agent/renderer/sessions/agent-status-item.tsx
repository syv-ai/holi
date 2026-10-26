import { useAtomValue, useSetAtom } from "jotai"
import { AstroidIcon } from "lucide-react"

import { appModeAtom, StatusBarItem } from "@/plugin-api"
import { agentsStatusAtom } from "../state/agents-status"
import { openSessionRowsAtom } from "../state/session-list"

/**
 * The agent's item in the status bar (docs/features/status-bar.md): how many
 * sessions are working or waiting on you, from the same counts the mode
 * toggle reports, else how many the sidebar's Sessions holds. A live session
 * closed out of Sessions, or never opened there, is not counted: the number
 * is the list's. Nothing while Sessions is empty. A click opens Agents.
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
  const open = useAtomValue(openSessionRowsAtom)
  const status = useAtomValue(agentsStatusAtom)
  const setMode = useSetAtom(appModeAtom)
  const text = agentStatusText(open.length, status)
  if (text === null) return null
  return (
    <StatusBarItem
      tooltip={`Agents: ${text}. Click to open Agents`}
      onClick={() => setMode("agents")}
    >
      <AstroidIcon aria-hidden />
      {text}
    </StatusBarItem>
  )
}
