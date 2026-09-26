/**
 * The sidebar's list of the vault's agent sessions (D100, D101): with no tab
 * open, this is the only place a session shows.
 *
 * Always present, unlike the apps section, which hides itself when the vault has
 * none: otherwise a vault whose sessions have all ended would have no way to
 * start one but ⌘J. Headed "chats" rather than "sessions" because that is what
 * the rows are to the person reading the sidebar.
 *
 * Its rows are tree rows, not chips, for `AppsSection`'s reason, and take the
 * tree row's metrics so they line up with the file icons above.
 *
 * Rename does not keep a Holi-side name: it pastes `/rename ` into the session,
 * because the name is Claude Code's own (`--name` at spawn, `/rename` inside),
 * and a copy kept in Holi would go stale.
 */
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { ChevronRight, History, Plus } from 'lucide-react'
import { useState } from 'react'
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Dialog,
  Tooltip,
} from '@/primitives'
import { cn } from '@/lib/cn'
import {
  activeSessionAtom,
  activeSessionIdAtom,
  agentSessionsAtom,
  agentSessionsSectionOpenAtom,
  type AgentSession,
} from '@/state/agent'
import { useSessionIndicator } from './session-indicator'
import { openSession, workspaceAtom } from '@/state/panes'
import {
  duplicateSessionAtom,
  renameSessionAtom,
  restartSessionAtom,
  startSessionAtom,
} from '@/state/agent-send'

export function SessionsSection(): React.JSX.Element {
  const sessions = useAtomValue(agentSessionsAtom)
  const active = useAtomValue(activeSessionAtom)
  const setActiveId = useSetAtom(activeSessionIdAtom)
  const setWorkspace = useSetAtom(workspaceAtom)
  const startSession = useSetAtom(startSessionAtom)
  const duplicateSession = useSetAtom(duplicateSessionAtom)
  const restartSession = useSetAtom(restartSessionAtom)
  const renameSession = useSetAtom(renameSessionAtom)
  const [open, setOpen] = useAtom(agentSessionsSectionOpenAtom)
  const [confirming, setConfirming] = useState<AgentSession | null>(null)

  const indicatorFor = useSessionIndicator()

  /** Show this session: its tab opens, or comes forward if already open (D101). */
  const show = (session: AgentSession) => {
    setActiveId(session.id)
    setWorkspace((w) => openSession(w, session.id))
  }

  const end = async (session: AgentSession) => {
    setConfirming(null)
    await window.holi.agent.kill(session.id)
  }

  /** End this one and start a genuinely new session under its name: the
   *  conversation does not survive a restart, the name does. */
  const restart = (session: AgentSession) => restartSession(session.id)

  return (
    // Fills its resizable panel: a header that never scrolls, and a list that
    // does. The header is what stays visible when the panel is collapsed to it,
    // so its `shrink-0` is load-bearing.
    <div className="group/sessions relative flex h-full flex-col overflow-hidden">
      {/* The explorer's section-action pattern: floated top-right, hidden until
          you are in the section. */}
      <div className="motion-respond pointer-events-none absolute right-2 top-0.5 z-10 flex items-center gap-0.5 opacity-0 focus-within:pointer-events-auto focus-within:opacity-100 group-hover/sessions:pointer-events-auto group-hover/sessions:opacity-100">
        <Tooltip content="resume a past session in a new tab">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="resume a past session"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => void startSession({ resume: true })}
          >
            <History size={14} />
          </Button>
        </Tooltip>
        <Tooltip content="start another session">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="start another session"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => void startSession()}
          >
            <Plus size={14} />
          </Button>
        </Tooltip>
      </div>
      {/* The whole header is the toggle. Same metrics and lowercase as the apps
          section. */}
      <Button
        variant="ghost"
        size="xs"
        aria-expanded={open}
        className="h-[22px] w-full shrink-0 justify-start gap-1 rounded-none px-2 text-sm font-medium text-muted-foreground hover:bg-accent/60"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight
          className="size-3.5 motion-respond"
          style={{ transform: open ? 'rotate(90deg)' : 'none' }}
          aria-hidden="true"
        />
        chats
      </Button>
      {open && sessions.length > 0 && (
        // No horizontal padding on the list: each row carries its own `px-2`,
        // the way a tree row does, so a hover highlight spans the sidebar.
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-1">
          {sessions.map((session) => {
            const indicator = indicatorFor(session)
            return (
              <ContextMenu key={session.id}>
                <Tooltip content={indicator.title}>
                  <ContextMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="xs"
                      data-session-card={session.id}
                      className={cn(
                        // The tree row's metrics, overriding the chip ones
                        // `size="xs"` brings.
                        'h-[22px] w-full justify-start gap-1 rounded px-2 text-sm font-normal',
                        session.id === active?.id
                          ? 'text-brand'
                          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                        session.exited && 'opacity-60',
                      )}
                      onClick={() => show(session)}
                    >
                      {/* The chevron column a tree row starts with, kept empty
                          so the dots line up with the file icons above. */}
                      <span className="w-4 shrink-0" aria-hidden="true" />
                      <span className="flex w-4 shrink-0 justify-center">
                        <span
                          aria-hidden="true"
                          className={cn('h-2 w-2 rounded-full', indicator.dot)}
                        />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-left">{session.name}</span>
                      {/* The state in words, because a dot alone cannot say
                          WHAT it is waiting for and that is the whole reason to
                          walk over to it. Coloured text on no background, never
                          on a tint of its own hue. */}
                      <span
                        className={cn(
                          'shrink-0 text-xs',
                          session.state === 'needs-you' && !session.exited
                            ? 'text-orange-400'
                            : 'text-muted-foreground',
                        )}
                      >
                        {indicator.state}
                      </span>
                    </Button>
                  </ContextMenuTrigger>
                </Tooltip>
                {/* Radix hands focus back to the row when the menu closes, AFTER
                    the item's work, which would pull the keyboard out of the
                    terminal Rename just focused. Nothing on this menu wants the
                    row focused afterwards. */}
                <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
                  {/* No dialog: the command goes in the session's box and the
                      name is typed where it is going to be read. */}
                  <ContextMenuItem
                    disabled={session.exited}
                    onSelect={() => void renameSession(session.id)}
                  >
                    Rename
                  </ContextMenuItem>
                  {/* A copy of the conversation, in a session of its own: the
                      original keeps running and neither sees the other's turns.
                      Offered for an exited session too: its transcript is
                      exactly what a fork is made of. */}
                  <ContextMenuItem onSelect={() => void duplicateSession(session.id)}>
                    Duplicate
                  </ContextMenuItem>
                  <ContextMenuItem disabled={session.exited} onSelect={() => void restart(session)}>
                    Restart
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    variant="destructive"
                    onSelect={() => {
                      if (session.state === 'idle' || session.exited) void end(session)
                      else setConfirming(session)
                    }}
                  >
                    End session
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            )
          })}
        </div>
      )}

      {confirming !== null && (
        <Dialog open onClose={() => setConfirming(null)} size="sm">
          <div className="grid min-w-0 gap-4 [&>*]:min-w-0">
            <Dialog.Header>End {confirming.name}?</Dialog.Header>
            <Dialog.Body>
              <p className="text-xs text-muted-foreground">
                {confirming.state === 'needs-you'
                  ? 'It is waiting for you to answer something. Ending it now drops the question and whatever it was about to do.'
                  : 'It is mid-turn. Ending it now stops the work part-way; what it has already written stays in the vault.'}
              </p>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={() => void end(confirming)}>
                End session
              </Button>
            </Dialog.Footer>
          </div>
        </Dialog>
      )}
    </div>
  )
}
