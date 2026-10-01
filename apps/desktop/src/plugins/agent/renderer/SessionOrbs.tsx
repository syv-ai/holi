/**
 * The vault's running sessions as their status orbs, stacked, for the rail
 * that stands in for the nav while it is hidden (⌥⌘S).
 *
 * The sidebar's session rows are where sessions live, and where you see which
 * one is waiting on you. Hidden, the nav took both away. So each live session
 * keeps an element here with the same orb (`agentIndicator`), its name and
 * state in the tooltip, and a press opens it the way its row does.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Button, Tooltip } from '@/primitives'
import { cn } from '@/plugin-api'
import { agentIndicator } from './lib/notices'
import { activeSessionAtom, agentSessionsAtom } from './state/sessions'
import { openSessionAtom } from './state/send'

export function SessionOrbs(): React.JSX.Element {
  const sessions = useAtomValue(agentSessionsAtom)
  const active = useAtomValue(activeSessionAtom)
  const openSession = useSetAtom(openSessionAtom)

  return (
    <>
      {sessions.map((session) => {
        const indicator = agentIndicator(session)
        return (
          <Tooltip key={session.id} content={`${session.name}: ${indicator.title}`}>
            <Button
              variant="ghost"
              size="xs"
              aria-label={`${session.name}, ${indicator.state}`}
              data-session-orb={session.id}
              // A dot, not a glyph, so not an IconButton: the xs button
              // squared to the rail's 24px slot.
              className={cn('size-6 px-0', session.id === active?.id && 'bg-accent')}
              onClick={() => void openSession(session.id)}
            >
              <span aria-hidden="true" className={cn('h-2 w-2 rounded-full', indicator.dot)} />
            </Button>
          </Tooltip>
        )
      })}
    </>
  )
}
