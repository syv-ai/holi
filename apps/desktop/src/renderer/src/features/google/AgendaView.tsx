/**
 * The agenda — your Google Calendar for the next few days, and the one place
 * an event becomes a task.
 *
 * **Account-wide, not vault content** (D67): this shows the same events
 * whichever vault is open. Creating a task from an event is the one write, and
 * it writes a *task file* — no calendar scope is involved, and none is granted.
 *
 * Fetched on open and on refresh, never polled. Nothing is cached to disk;
 * Google stays the source of truth, so offline says so rather than showing a
 * stale day.
 */
import { useCallback, useEffect, useState } from 'react'
import { CalendarDays, ExternalLink, RefreshCw, Video } from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Button, Tooltip } from '@/primitives'
import { trpc } from '../../lib/trpc'
import { activeRemoteAtom } from '../../state/vaults'
import { openNoteTabAtom } from '../../state/panes'

interface CalendarEvent {
  id: string
  title: string
  start: string
  end: string
  allDay: boolean
  location?: string
  htmlLink: string
  calendarId: string
  calendarName: string
  meetLink?: string
}

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; events: CalendarEvent[] }
  | { kind: 'disconnected' }
  | { kind: 'error'; message: string }

/** How far ahead the agenda looks. A week is the horizon a person plans over;
 *  anything longer stops being an agenda and starts being a calendar. */
const DAYS_AHEAD = 7

/**
 * The window, computed **in the renderer**.
 *
 * Main never derives "today" — the machine's local date is a renderer fact, and
 * a main-side `new Date()` disagrees with it across a timezone boundary. Same
 * rule daily notes follow.
 */
function agendaWindow(): { timeMin: string; timeMax: string } {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + DAYS_AHEAD)
  return { timeMin: start.toISOString(), timeMax: end.toISOString() }
}

/** `2026-08-04` for a timed instant or an all-day date, in local time. */
function dayKeyOf(event: CalendarEvent): string {
  if (event.allDay) return event.start.slice(0, 10)
  const d = new Date(event.start)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function dayLabel(key: string): string {
  const today = new Date()
  const date = new Date(`${key}T00:00:00`)
  const days = Math.round((date.getTime() - new Date(today.toDateString()).getTime()) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

function timeLabel(event: CalendarEvent): string {
  if (event.allDay) return 'all day'
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return `${fmt(event.start)} – ${fmt(event.end)}`
}

export function AgendaView() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const remote = useAtomValue(activeRemoteAtom)
  const openNote = useSetAtom(openNoteTabAtom)
  const [creating, setCreating] = useState<string | null>(null)

  const load = useCallback(() => {
    setState({ kind: 'loading' })
    void trpc.google.agenda
      .query(agendaWindow())
      .then((events) => setState({ kind: 'ready', events }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Could not load your agenda.'
        // A missing/expired connection is not an error to apologise for — it is
        // a state with an obvious next action, so it gets its own surface.
        setState(
          /not connected|connect Google|no longer valid|not configured/i.test(message)
            ? { kind: 'disconnected' }
            : { kind: 'error', message },
        )
      })
  }, [])

  useEffect(load, [load])

  /**
   * Make a task out of an event.
   *
   * The event's Google permalink goes in the **body**, as an ordinary markdown
   * link (D67) — no frontmatter field, nothing machine-owned. That is the whole
   * representation; "which tasks reference this event" is a grep for the URL.
   */
  const createTask = async (event: CalendarEvent) => {
    if (remote === null) return
    setCreating(event.id)
    try {
      const { path } = await trpc.tasks.create.mutate({
        remote,
        title: event.title,
        folder: '',
        description: `[${event.title}](${event.htmlLink})\n`,
      })
      openNote(path)
    } finally {
      setCreating(null)
    }
  }

  if (state.kind === 'loading') {
    return <Placeholder>Loading your agenda…</Placeholder>
  }

  if (state.kind === 'disconnected') {
    return (
      <Placeholder>
        Google isn&rsquo;t connected. Connect it in vault settings to see your calendar.
      </Placeholder>
    )
  }

  if (state.kind === 'error') {
    return (
      <Placeholder>
        {state.message}
        <Button variant="secondary" size="sm" className="mt-3" onClick={load}>
          Try again
        </Button>
      </Placeholder>
    )
  }

  const byDay = new Map<string, CalendarEvent[]>()
  for (const event of state.events) {
    const key = dayKeyOf(event)
    byDay.set(key, [...(byDay.get(key) ?? []), event])
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 px-4">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <CalendarDays size={15} />
          Agenda
        </h2>
        <Tooltip content="refresh">
          <Button variant="ghost" size="icon-xs" aria-label="refresh agenda" onClick={load}>
            <RefreshCw size={14} />
          </Button>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        {byDay.size === 0 ? (
          <p className="mt-6 text-sm text-muted-foreground">Nothing scheduled in the next week.</p>
        ) : (
          [...byDay.entries()].map(([day, events]) => (
            <section key={day} className="mb-5">
              <h3 className="sticky top-0 bg-background py-1 text-xs font-medium text-muted-foreground">
                {dayLabel(day)}
              </h3>
              <ul className="space-y-1">
                {events.map((event) => (
                  <li
                    key={`${event.calendarId}:${event.id}`}
                    className="group flex items-baseline gap-3 rounded px-2 py-1.5 hover:bg-secondary/60"
                  >
                    <span className="w-28 shrink-0 font-mono text-xs text-muted-foreground">
                      {timeLabel(event)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{event.title}</span>
                      {(event.location !== undefined || event.calendarName !== '') && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {[event.calendarName, event.location].filter(Boolean).join(' · ')}
                        </span>
                      )}
                    </span>

                    {/* Actions stay hidden until hover: an agenda is read most of
                        the time, and three buttons per row is a wall. */}
                    <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      {event.meetLink !== undefined && (
                        <Tooltip content="join the meeting">
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`join ${event.title}`}
                            onClick={() => void window.holi.openExternal(event.meetLink!)}
                          >
                            <Video size={14} />
                          </Button>
                        </Tooltip>
                      )}
                      <Tooltip content="open in Google Calendar">
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`open ${event.title} in Google Calendar`}
                          onClick={() => void window.holi.openExternal(event.htmlLink)}
                        >
                          <ExternalLink size={14} />
                        </Button>
                      </Tooltip>
                      <Button
                        variant="secondary"
                        size="xs"
                        disabled={remote === null || creating === event.id}
                        onClick={() => void createTask(event)}
                      >
                        {creating === event.id ? 'Creating…' : 'Task'}
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  )
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}
