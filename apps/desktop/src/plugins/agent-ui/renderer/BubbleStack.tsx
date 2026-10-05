/**
 * Every agent the vault has had, as a stack of bubbles, the one started last
 * on top. Resting, it is the top few overlapped, like Android's chat bubbles;
 * with the pointer on it, or the keyboard in it, it fans out into the whole
 * history, a bubble and a name each, and pressing one opens that agent's chat.
 *
 * The fan is the same bubbles moved, not another list drawn, so opening and
 * closing is a transition (`overview.css`). The finished ones are dimmed with
 * their eyes shut, and a live one keeps its status dot.
 */
import { Archive, Plus } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Icon,
  IconButton,
} from '@/primitives'
import { cn } from '@/plugin-api'
import { AgentFace } from './AgentFace'
import { agentIndicator } from '../../agent/renderer/lib/notices'
import type { StackEntry } from '../../agent/renderer/state/sessions'

/** How many bubbles show while the stack rests. */
export const RESTING = 3
/** How long the pointer may leave before the fan closes, so crossing a gap
 *  between two bubbles does not. */
const CLOSE_DELAY_MS = 160

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** When a session was started, as a person says it: "just now", "5 min ago",
 *  "3 h ago", "2 d ago", else the date. */
export function ago(startedAt: number, now: number): string {
  const elapsed = Math.max(0, now - startedAt)
  if (elapsed < MINUTE) return 'just now'
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`
  if (elapsed < 14 * DAY) return `${Math.floor(elapsed / DAY)} d ago`
  return new Date(startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** What an entry says under its name: what a live one is doing, how a past
 *  one ended, and when it began. */
function subline(entry: StackEntry, now: number): string {
  const when = entry.startedAt === 0 ? '' : ` · ${ago(entry.startedAt, now)}`
  if (entry.kind === 'past') {
    return `${entry.session.phase === 'failed' ? 'Ended badly' : 'Finished'}${when}`
  }
  return `${agentIndicator(entry.session).state}${when}`
}

export function BubbleStack({
  entries,
  shownId,
  onPick,
  onFace,
  onNew,
  onRestart,
  onDuplicate,
  onArchive,
  onStop,
  archivedCount,
  onHistory,
}: {
  /** Most recent first. */
  entries: readonly StackEntry[]
  /** The one whose chat is open. */
  shownId: string | null
  /** The words of a row: the full chat. */
  onPick: (id: string) => void
  /** The face of a row: the small chat, or the chat shown on the agents page. */
  onFace: (id: string) => void
  onNew: () => void
  /** A bubble's context menu: a live session's Restart, Duplicate and Stop,
   *  and Archive for any, which takes it out of the stack into the history. */
  onRestart: (id: string) => void
  onDuplicate: (id: string) => void
  onArchive: (id: string) => void
  onStop: (id: string) => void
  /** How many chats the history holds, and the way to it. */
  archivedCount: number
  onHistory: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(closing.current), [])

  const reveal = (): void => {
    clearTimeout(closing.current)
    setOpen(true)
  }
  /** A bubble's menu is open: the fan stays, or the menu would lose its
   *  bubble under the pointer. */
  const menu = useRef(false)
  const dismiss = (): void => {
    clearTimeout(closing.current)
    if (menu.current) return
    closing.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS)
  }

  // Read when the fan opens: a clock that ticks while it is open would only
  // make the words shuffle under the pointer.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (open) setNow(Date.now())
  }, [open])

  // The "+" is one more row, so the fan is one longer than the history.
  const rows = entries.length + 1
  // Something the resting stack hides, and that waits on you, must not wait
  // unseen.
  const hiddenNeedsYou = entries
    .slice(RESTING)
    .some((e) => e.kind === 'live' && e.session.state === 'needs-you')

  return (
    <nav
      aria-label="Agents"
      data-agent-stack=""
      data-open={open ? '' : undefined}
      // Nothing to stack: the "New session" bubble stands in its place.
      data-empty={entries.length === 0 ? '' : undefined}
      className="agent-stack"
      onPointerEnter={reveal}
      onPointerLeave={dismiss}
      onFocus={reveal}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) dismiss()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        clearTimeout(closing.current)
        setOpen(false)
      }}
    >
      <div
        className={cn('agent-fan rounded-3xl', open && 'bg-popover shadow-popover')}
        style={{ '--rows': rows } as CSSProperties}
      >
        <div className="agent-fan-scroll">
          <div className="agent-fan-inner">
            {entries.map((entry, index) => {
              const shown = entry.id === shownId
              const needsYou = entry.kind === 'live' && entry.session.state === 'needs-you'
              return (
                <ContextMenu
                  key={entry.id}
                  onOpenChange={(menuOpen) => {
                    menu.current = menuOpen
                    if (!menuOpen) dismiss()
                  }}
                >
                  <ContextMenuTrigger asChild>
                    {/* A row of three siblings, never a button in a button, the
                        face last so it stays where the resting stack's bubble
                        is and the pointer is already on it when the fan
                        opens: the archive button, the words, which open the
                        full chat, and the face, which opens the small chat. */}
                    <div className="agent-bubble" style={{ '--i': index } as CSSProperties}>
                      <IconButton
                        icon={Archive}
                        label={`Archive ${entry.name}`}
                        size="sm"
                        data-agent-archive={entry.id}
                        className="agent-bubble-archive"
                        onClick={() => onArchive(entry.id)}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        data-agent-open={entry.id}
                        aria-label={`Open ${entry.name} in full, ${subline(entry, now)}`}
                        className="agent-bubble-main p-0 font-normal"
                        onClick={() => {
                          onPick(entry.id)
                          setOpen(false)
                        }}
                      >
                        <span className="agent-bubble-label">
                          <span className="truncate text-sm text-foreground">{entry.name}</span>
                          <span
                            className={cn(
                              'truncate text-xs',
                              needsYou ? 'text-orange-400' : 'text-muted-foreground',
                            )}
                          >
                            {subline(entry, now)}
                          </span>
                        </span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        data-agent-bubble={entry.id}
                        data-kind={entry.kind}
                        data-shown={shown ? '' : undefined}
                        aria-current={shown ? 'true' : undefined}
                        aria-label={`Message ${entry.name}`}
                        className="agent-bubble-face-button p-0"
                        // The resting stack shows only its top; focusing any bubble
                        // opens it, which is how the keyboard reaches the rest.
                        onClick={() => {
                          onFace(entry.id)
                          setOpen(false)
                        }}
                      >
                        <span
                          className={cn(
                            'agent-bubble-face rounded-full',
                            shown && 'ring-2 ring-foreground/60',
                          )}
                        >
                          {entry.kind === 'live' ? (
                            <AgentFace
                              size="md"
                              seed={entry.id}
                              state={entry.session.state}
                              waitingFor={entry.session.waitingFor}
                              phase={entry.session.phase}
                            />
                          ) : (
                            <AgentFace size="md" seed={entry.id} state="off" muted />
                          )}
                        </span>
                      </Button>
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
                    {entry.kind === 'live' && (
                      <>
                        <ContextMenuItem onSelect={() => onRestart(entry.id)}>
                          Restart
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => onDuplicate(entry.id)}>
                          Duplicate
                        </ContextMenuItem>
                      </>
                    )}
                    {/* Out of the stack and into the history; a running one is
                      stopped first, so nothing runs out of sight. */}
                    <ContextMenuItem onSelect={() => onArchive(entry.id)}>Archive</ContextMenuItem>
                    {entry.kind === 'live' && (
                      <>
                        <ContextMenuSeparator />
                        <ContextMenuItem variant="destructive" onSelect={() => onStop(entry.id)}>
                          Stop session
                        </ContextMenuItem>
                      </>
                    )}
                  </ContextMenuContent>
                </ContextMenu>
              )
            })}
            <div
              className="agent-bubble agent-bubble-new"
              style={{ '--i': entries.length } as CSSProperties}
            >
              <Button
                variant="ghost"
                size="sm"
                aria-hidden="true"
                tabIndex={-1}
                className="agent-bubble-main p-0 font-normal"
                onClick={() => {
                  onNew()
                  setOpen(false)
                }}
              >
                <span className="agent-bubble-label">
                  <span className="truncate text-sm text-foreground">New session</span>
                </span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                data-agent-bubble-new=""
                aria-label="New session"
                className="agent-bubble-face-button p-0"
                onClick={() => {
                  onNew()
                  setOpen(false)
                }}
              >
                <span className="agent-bubble-face size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Icon icon={Plus} />
                </span>
              </Button>
            </div>
          </div>
        </div>
        {/* The way to the archived chats, small, at the foot of the menu. */}
        <Button
          variant="link"
          size="xs"
          data-agent-history-link=""
          className="agent-fan-footer h-auto p-0 text-xs font-normal text-muted-foreground hover:text-foreground"
          onClick={() => {
            onHistory()
            setOpen(false)
          }}
        >
          History{archivedCount > 0 ? ` · ${archivedCount}` : ''}
        </Button>
      </div>
      {entries.length > RESTING && (
        <span
          aria-hidden="true"
          data-agent-stack-more=""
          className={cn(
            'agent-stack-more rounded-full bg-secondary px-1.5 text-[11px] text-secondary-foreground tabular-nums',
            hiddenNeedsYou && 'ring-2 ring-orange-400',
          )}
        >
          +{entries.length - RESTING}
        </span>
      )}
    </nav>
  )
}
