/**
 * What a chat's Claude Code runs with, from its `init`: its version and
 * model, its MCP servers and whether they connected, and the tools it may
 * call. In a popover off the chat's header.
 */
import { InfoIcon } from "lucide-react"

import { Badge } from "@/components/reui/badge"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { modelLabel, type SessionInfo as Info } from "../shared/chat"

const SERVER: Record<
  string,
  "success-light" | "warning-light" | "destructive-light" | "secondary"
> = {
  connected: "success-light",
  pending: "warning-light",
  "needs-auth": "warning-light",
  failed: "destructive-light",
}

export function SessionInfo({ info }: { info: Info }) {
  const builtin = info.tools.filter((t) => !t.startsWith("mcp__"))
  const mcpTools = info.tools.length - builtin.length
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="What this session runs with"
        >
          <InfoIcon aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-3" data-session-info="">
        <div className="flex flex-col gap-0.5">
          <p className="text-sm font-medium">Claude Code</p>
          <p className="text-muted-foreground text-xs">
            {[
              info.version === undefined ? null : `Version ${info.version}`,
              info.model === undefined ? null : modelLabel(info.model),
            ]
              .filter(Boolean)
              .join(" · ") || "As its last process reported"}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <p className="text-muted-foreground text-xs font-medium">
            MCP servers
          </p>
          {info.mcpServers.length === 0 ? (
            <p className="text-muted-foreground text-xs">None configured.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {info.mcpServers.map((s) => (
                <li
                  key={s.name}
                  className="flex min-w-0 items-center justify-between gap-2 text-sm"
                >
                  <span className="min-w-0 truncate">{s.name}</span>
                  <Badge variant={SERVER[s.status] ?? "secondary"}>
                    {s.status}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <p className="text-muted-foreground text-xs font-medium">
            Tools · {builtin.length}
            {mcpTools > 0 ? ` and ${mcpTools} from MCP` : ""}
          </p>
          <ul className="flex max-h-40 flex-wrap gap-1 overflow-y-auto">
            {builtin.map((t) => (
              <li key={t}>
                <Badge variant="outline">{t}</Badge>
              </li>
            ))}
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  )
}
