/**
 * The sidebar's list of the vault's agent sessions (D100), and since D101 the
 * whole of what the app says about them outside their own tabs.
 *
 * **A session with no tab open has nothing else on screen.** The drawer used to
 * hold them all and the footer reduced them to one dot; both are gone, and what
 * replaced them is this: a card per session, its name, its state in words, and
 * everything you can do to one, always visible while the sidebar is.
 *
 * **Always present, unlike the apps section**, which hides itself when the vault
 * has none. It used to follow that rule, and could while the footer carried a
 * Claude control: with that gone (D101), a vault whose sessions have all ended
 * would have no way to start one but ⌘J. So the heading stays whatever the vault
 * holds, and the `+` beside it is the way to the first one.
 *
 * **It is headed "chats"**, not "sessions", which is the word everywhere else —
 * the glossary, the docs, Claude Code's own CLI. The heading is the one place
 * the jargon is not worth it: what the rows are, to the person reading the
 * sidebar, is conversations.
 *
 * **It fills a resizable panel**, exactly as the apps section does: a header
 * that never scrolls and a list that does. It used to size to its contents
 * below the sidebar's group, on the reasoning that a handful of rows does not
 * earn a handle — which held while a vault had one session and stopped holding
 * the moment it could have six, because the tree then lost its height to a list
 * nobody could shrink.
 *
 * **The rows are tree rows, not chips**, for `AppsSection`'s reason: a section
 * that styles itself as chips reads as a fourth chip row stuck under the tree.
 * So they take the tree row's metrics verbatim (22px, `text-sm`, `font-normal`)
 * and line up with the file icons above them.
 *
 * There is no Rename. The name is Claude Code's own, set with `--name` at spawn
 * or `/rename` inside the session, and a second one kept beside it in Holi would
 * be a copy that goes stale the moment anybody types `/rename`.
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
import { agentIndicator, agentThemeNote } from '@/lib/agent-notices'
import {
  activeSessionAtom,
  activeSessionIdAtom,
  agentModeAtSpawnAtom,
  agentSessionsAtom,
  agentSessionsSectionOpenAtom,
  type AgentSession,
} from '@/state/agent'
import { activeModeAtom } from '@/state/color-scheme'
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
  const modeAtSpawn = useAtomValue(agentModeAtSpawnAtom)
  const mode = useAtomValue(activeModeAtom)
  const [open, setOpen] = useAtom(agentSessionsSectionOpenAtom)
  const [confirming, setConfirming] = useState<AgentSession | null>(null)

  const indicatorFor = (session: AgentSession) =>
    agentIndicator({
      ...session,
      themeNote: agentThemeNote({
        running: !session.exited,
        modeAtSpawn: modeAtSpawn[session.id] ?? null,
        mode,
      }),
    })

  /** Show this session: its tab opens, or comes forward if it is already open
   *  (D101). The one thing a card does that the footer door cannot, which is why
   *  the card names a session. */
  const show = (session: AgentSession) => {
    setActiveId(session.id)
    setWorkspace((w) => openSession(w, session.id))
  }

  const end = async (session: AgentSession) => {
    setConfirming(null)
    await window.holi.agent.kill(session.id)
  }

  /** End this one and start another under its name. A genuinely new session
   *  rather than the same one reborn, which is what restarting a process
   *  actually is — saying otherwise would pretend a conversation survived that
   *  did not. The name survives, because it was chosen for the work. */
  const restart = (session: AgentSession) => restartSession(session.id)

  return (
    // Fills its panel: a header that never scrolls, and a list that does. The
    // header is also what stays visible when the panel is collapsed to it, so
    // `shrink-0` on it is load-bearing rather than tidiness.
    <div className="group/sessions relative flex h-full flex-col overflow-hidden">
      {/* The two actions the drawer's header used to carry, in the explorer's
          section-action pattern: floated top-right, and out of sight until you
          are in the section. Starting a session is not something you do often
          enough to spend a permanent row on, and neither is going back to an old
          one — but when the drawer went, this became the only place either of
          them could live. */}
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
      {/* The whole header is the toggle, not a chevron you have to hit. Same
          metrics and same lowercase as the apps section: nothing in this sidebar
          shouts. */}
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
                {/* Radix hands focus back to the row when the menu closes, and it
                    does so AFTER the item's work: Rename had already put the
                    keyboard in the terminal, and the menu took it back to the
                    row, so the name went nowhere. Nothing on this menu wants
                    the row focused afterwards: three of the four land you in a
                    tab that focuses its own terminal, and the fourth opens a
                    dialog or removes the row. */}
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
                      Offered for an exited session too — its transcript is
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
