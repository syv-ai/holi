/**
 * The vault's agent sessions as a menu, for while the nav is hidden.
 *
 * The nav's chats section is where sessions live, and hiding the nav (⌥⌘S)
 * used to take them out of reach of the mouse. This sits beside the show-
 * sidebar button at the start of the first pane's strip: every session, opened
 * the way its row opens it (its tab, or brought forward), and a new one.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { MessagesSquare, Plus } from 'lucide-react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
} from '@/primitives'
import { cn } from '@/lib/cn'
import { activeSessionIdAtom, agentSessionsAtom } from '@/state/agent'
import { startSessionAtom } from '@/state/agent-send'
import { openSession, workspaceAtom } from '@/state/panes'

export function SessionsMenu(): React.JSX.Element {
  const sessions = useAtomValue(agentSessionsAtom)
  const activeId = useAtomValue(activeSessionIdAtom)
  const setActiveId = useSetAtom(activeSessionIdAtom)
  const setWorkspace = useSetAtom(workspaceAtom)
  const startSession = useSetAtom(startSessionAtom)

  return (
    <DropdownMenu>
      <Tooltip content="chats">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="shrink-0 text-muted-foreground"
            aria-label="chats"
          >
            <MessagesSquare size={16} />
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="start" className="max-w-72">
        {sessions.map((session) => (
          <DropdownMenuItem
            key={session.id}
            className={cn(
              'text-xs',
              session.id === activeId && 'text-brand',
              session.exited && 'opacity-60',
            )}
            onSelect={() => {
              setActiveId(session.id)
              setWorkspace((w) => openSession(w, session.id))
            }}
          >
            <span className="truncate">{session.name}</span>
          </DropdownMenuItem>
        ))}
        {sessions.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem className="text-xs" onSelect={() => void startSession()}>
          <Plus />
          New session
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
