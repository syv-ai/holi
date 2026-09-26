/**
 * The vault's running sessions as their status orbs, stacked, for the rail
 * that stands in for the nav while it is hidden (⌥⌘S).
 *
 * The nav's chats section is where sessions live, and it is also where you see
 * which one is waiting on you. Hidden, the nav took both away. So each running
 * session keeps an element here with the same orb (`useSessionIndicator`), its
 * name and state in the tooltip, and a press opens it the way its row does:
 * its tab, or brought forward. An ended session has nothing to report and
 * stays in the nav.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Button, Tooltip } from '@/primitives'
import { cn } from '@/lib/cn'
import { activeSessionAtom, activeSessionIdAtom, agentSessionsAtom } from '@/state/agent'
import { openSession, workspaceAtom } from '@/state/panes'
import { useSessionIndicator } from './session-indicator'

export function SessionOrbs(): React.JSX.Element {
  const sessions = useAtomValue(agentSessionsAtom)
  const active = useAtomValue(activeSessionAtom)
  const setActiveId = useSetAtom(activeSessionIdAtom)
  const setWorkspace = useSetAtom(workspaceAtom)
  const indicatorFor = useSessionIndicator()

  return (
    <>
      {sessions
        .filter((session) => !session.exited)
        .map((session) => {
          const indicator = indicatorFor(session)
          return (
            <Tooltip key={session.id} content={`${session.name}: ${indicator.title}`}>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`${session.name}, ${indicator.state}`}
                data-session-orb={session.id}
                className={cn('shrink-0', session.id === active?.id && 'bg-accent')}
                onClick={() => {
                  setActiveId(session.id)
                  setWorkspace((w) => openSession(w, session.id))
                }}
              >
                <span aria-hidden="true" className={cn('h-2 w-2 rounded-full', indicator.dot)} />
              </Button>
            </Tooltip>
          )
        })}
    </>
  )
}
