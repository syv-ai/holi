/**
 * The vault's live Claude Code sessions, one row each, under the file tree.
 *
 * Only live ones: a session whose process has ended (stopped, finished and
 * retired by Claude Code's supervisor) is in the agent list that ⌘J and the
 * agent icon open, not here. So there is no header, no `+` and nothing to
 * collapse: with no session running there are no rows at all.
 *
 * A row opens its session. Stop, on the row itself, is `claude stop`: the
 * conversation stays in the agent list and picks up where it left off. An idle
 * session stops at once; one mid-turn, or waiting on an answer, asks first,
 * because that turn is cut short.
 *
 * Stop shows on hover and on keyboard focus. The rest of the time its slot
 * holds how much of the session's context window is used: muted like
 * the name below 60%, then amber ramping to red at 99%.
 *
 * The rows take the tree row's height, and their dots sit on the centre of
 * the nav menu's first icon below.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { CircleStop } from 'lucide-react'
import { useState } from 'react'
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Dialog,
  IconButton,
  Tooltip,
} from '@/primitives'
import { agentIndicator, contextColour, needsYouIcon, sessionsWorthAsking } from './lib/notices'
import { cn } from '@/plugin-api'
import { activeSessionAtom, agentSessionsAtom, type AgentSession } from './state/sessions'
import {
  duplicateSessionAtom,
  openSessionAtom,
  respawnSessionAtom,
  stopSessionAtom,
} from './state/send'

export function SessionRows(): React.JSX.Element | null {
  const sessions = useAtomValue(agentSessionsAtom)
  const active = useAtomValue(activeSessionAtom)
  const openSession = useSetAtom(openSessionAtom)
  const stopSession = useSetAtom(stopSessionAtom)
  const respawnSession = useSetAtom(respawnSessionAtom)
  const duplicateSession = useSetAtom(duplicateSessionAtom)
  const [confirming, setConfirming] = useState<AgentSession | null>(null)

  if (sessions.length === 0) return null

  const stop = (session: AgentSession) => {
    setConfirming(null)
    void stopSession(session.id).then((res) => {
      if (!res.ok) console.warn(`[agent] stop ${session.id} failed: ${res.message}`)
    })
  }

  /** Stop, asking first only when something is actually cut short. */
  const requestStop = (session: AgentSession) => {
    if (sessionsWorthAsking([session]).length > 0) setConfirming(session)
    else stop(session)
  }

  return (
    // No horizontal padding: each row carries its own `px-2`, the way a tree
    // row does, so a hover highlight spans the sidebar.
    <div className="flex shrink-0 flex-col pb-3 pt-1" data-session-rows="">
      {sessions.map((session) => {
        const indicator = agentIndicator(session)
        const percent = session.contextPercent
        const colour = percent === undefined ? null : contextColour(percent)
        const NeedsYou = session.state === 'needs-you' ? needsYouIcon(session.waitingFor) : null
        return (
          <ContextMenu key={session.id}>
            <ContextMenuTrigger asChild>
              <div className="group/row relative flex items-center">
                <Tooltip content={indicator.title}>
                  <Button
                    variant="ghost"
                    size="xs"
                    data-session-row={session.id}
                    className={cn(
                      // The tree row's height, overriding the chip metrics
                      // `size="xs"` brings. `pl-5` puts the dot's centre on
                      // the nav menu's first icon (its dock's `p-2` plus the
                      // menu's own inset plus half a 32px icon). Right padding
                      // leaves room for Stop, or holds the context reading,
                      // which is at least Stop's width. Hover is the text
                      // colour alone, so the ghost variant's hover background
                      // is cancelled.
                      'h-[22px] w-full justify-start gap-1 rounded py-0 pl-5 text-sm font-normal hover:bg-transparent dark:hover:bg-transparent',
                      percent === undefined ? 'pr-7' : 'pr-2',
                      session.id === active?.id
                        ? 'text-brand'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                    onClick={() => void openSession(session.id)}
                  >
                    <span className="flex w-4 shrink-0 justify-center">
                      <span
                        aria-hidden="true"
                        className={cn('h-2 w-2 rounded-full', indicator.dot)}
                      />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-left">{session.name}</span>
                    {/* What it waits for, because a dot alone cannot say WHAT,
                        and that is the whole reason to walk over to it. An
                        icon, with the words in the tooltip. Coloured, on no
                        background. Wrapped, because a bare svg child would
                        switch on the button's own icon padding and move the
                        dot. */}
                    {NeedsYou && (
                      <span className="flex shrink-0">
                        <NeedsYou aria-hidden="true" className="size-3.5 text-orange-400" />
                      </span>
                    )}
                    {/* In Stop's slot, right-aligned with its glyph, and in
                        the flow so a long name truncates before it. Hidden
                        exactly when Stop shows, by opacity so nothing moves. */}
                    {percent !== undefined && (
                      <span
                        data-session-context={session.id}
                        className={cn(
                          'min-w-5 shrink-0 text-right text-xs tabular-nums group-focus-within/row:opacity-0 group-hover/row:opacity-0',
                          colour === null && 'text-muted-foreground',
                        )}
                        style={colour === null ? undefined : { color: colour }}
                      >
                        {percent}%
                      </span>
                    )}
                  </Button>
                </Tooltip>
                <IconButton
                  icon={CircleStop}
                  label="Stop session"
                  size="sm"
                  data-session-stop={session.id}
                  className="absolute right-1 opacity-0 focus-visible:opacity-100 group-focus-within/row:opacity-100 group-hover/row:opacity-100"
                  onClick={() => requestStop(session)}
                />
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
              {/* A fresh process for the same conversation: it picks up changed
                  settings and AGENTS.md. */}
              <ContextMenuItem onSelect={() => void respawnSession(session.id)}>
                Restart
              </ContextMenuItem>
              {/* A copy of the conversation in a session of its own: the
                  original keeps running and neither sees the other's turns. */}
              <ContextMenuItem onSelect={() => void duplicateSession(session.id)}>
                Duplicate
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onSelect={() => requestStop(session)}>
                Stop session
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )
      })}

      {confirming !== null && (
        <Dialog open onClose={() => setConfirming(null)} size="sm">
          <div className="grid min-w-0 gap-4 [&>*]:min-w-0">
            <Dialog.Header>Stop {confirming.name}?</Dialog.Header>
            <Dialog.Body>
              <p className="text-xs text-muted-foreground">
                {confirming.state === 'needs-you'
                  ? 'It is waiting for you to answer something, and stopping drops the question.'
                  : 'It is mid-turn, and stopping cuts the turn short. What it has already written stays in the vault.'}{' '}
                The conversation stays in the agents list and picks up where it left off.
              </p>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={() => stop(confirming)}>
                Stop session
              </Button>
            </Dialog.Footer>
          </div>
        </Dialog>
      )}
    </div>
  )
}
