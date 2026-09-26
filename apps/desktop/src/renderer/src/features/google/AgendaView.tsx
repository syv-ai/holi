/**
 * The agenda — your Google Calendar for the next few days, and the one place
 * an event becomes a task.
 *
 * **Account-wide, not vault content** (D67): this shows the same events
 * whichever vault is open. Creating a task from an event writes a *task file*,
 * not a calendar event.
 *
 * Fetched on open and on refresh, never polled. A cached agenda may paint
 * first, but the live fetch always replaces it.
 *
 * **A list and a detail pane**, because a row cannot hold an invitation: the
 * detail is mostly the description (the dial-in, the agenda, the links).
 */
import { useCallback, useEffect, useState } from 'react'
import {
  CalendarDays,
  ExternalLink,
  MapPin,
  RefreshCw,
  Repeat,
  User,
  Users,
  Video,
} from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  Tooltip,
} from '@/primitives'
import { SandboxedHtml } from './SandboxedHtml'
import { trpc } from '../../lib/trpc'
import { activeRemoteAtom } from '../../state/vaults'
import { openNoteTabAtom } from '../../state/panes'
import { useGlobalPanelLayout } from '../../state/preferences'

/** Mirrors `main/google/calendar.ts`. */
type RsvpStatus = 'needsAction' | 'tentative' | 'accepted' | 'declined'
type EventKind = 'default' | 'outOfOffice' | 'focusTime' | 'birthday' | 'fromGmail'

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
  /** From a calendar the user owns, rather than one they watch. */
  mine: boolean
  /** Google's own hex colour for the source calendar, or null. */
  color: string | null
  /** The user's own RSVP; null when they are not an attendee. */
  myResponse: RsvpStatus | null
  kind: EventKind
  /** False for a `transparent` event — on the calendar, but not taking time. */
  busy: boolean
  description: string | null
  attendeeCount: number
  organizer: string | null
  /** Meet, Zoom or Teams. */
  conferenceUrl: string | null
  recurring: boolean
}

/** What a non-meeting block is, in the two words a row has space for. `default`
 *  gets nothing: an ordinary meeting is the baseline and labelling it is noise. */
const KIND_LABELS: Partial<Record<EventKind, string>> = {
  outOfOffice: 'out of office',
  focusTime: 'focus time',
  birthday: 'birthday',
}

interface CalendarChoice {
  id: string
  name: string
  mine: boolean
  color: string | null
  enabled: boolean
}

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; events: CalendarEvent[] }
  | { kind: 'disconnected' }
  | { kind: 'error'; message: string }

/** How far ahead the agenda looks. */
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

/**
 * The second line of a row: what this block is, whose it is, and how big. The
 * organizer is named only for someone else's calendar, where "who called this"
 * is not already obvious.
 */
function detailLine(event: CalendarEvent): string {
  return [
    KIND_LABELS[event.kind],
    event.calendarName || undefined,
    event.location,
    event.attendeeCount > 1 ? `${event.attendeeCount} people` : undefined,
    event.organizer !== null && !event.mine ? event.organizer : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
}

function timeLabel(event: CalendarEvent): string {
  if (event.allDay) return 'all day'
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return `${fmt(event.start)} – ${fmt(event.end)}`
}

/** An event's identity across the merged agenda. Google ids are unique per
 *  calendar, not across them, so two calendars carrying the same meeting — a
 *  colleague's copy of a shared invitation — collide on `id` alone. */
function eventKey(event: CalendarEvent): string {
  return `${event.calendarId}:${event.id}`
}

/**
 * A description as markup, whichever shape it arrived in.
 *
 * **Every description goes through the one renderer** ([[SandboxedHtml]]): a
 * second rendering path is a second place for the sandbox to be forgotten, so
 * plain text is converted *into* the renderer's input. Google Calendar's editor
 * stores HTML, but API- or `.ics`-created events carry bare text whose newlines
 * HTML would collapse. `&` must be escaped first or it double-escapes the others.
 *
 * This is *not* sanitizing: the sanitizer downstream still decides what survives.
 */
function descriptionHtml(description: string): string {
  if (/<[a-z][^>]*>/i.test(description)) return description
  return description
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
}

/** The full date a detail pane has room for, where the row has only `timeLabel`. */
function longDayLabel(event: CalendarEvent): string {
  const date = event.allDay
    ? new Date(`${event.start.slice(0, 10)}T00:00:00`)
    : new Date(event.start)
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
}

export function AgendaView() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [calendars, setCalendars] = useState<CalendarChoice[]>([])
  const remote = useAtomValue(activeRemoteAtom)
  const openNote = useSetAtom(openNoteTabAtom)
  const [creating, setCreating] = useState<string | null>(null)
  /** Which row the detail pane is showing, by `eventKey`. */
  const [selected, setSelected] = useState<string | null>(null)
  /** Account-scoped, not per-vault: the agenda is the same calendar in every
   *  vault, and opens with no vault at all. See `useGlobalPanelLayout`. */
  const layout = useGlobalPanelLayout('agenda')

  const loadCalendars = useCallback(() => {
    // No error surface of its own: the agenda's error state already covers
    // "Google is unreachable", and one message per outage is enough.
    void trpc.google.calendars
      .query()
      .then(setCalendars)
      .catch(() => setCalendars([]))
  }, [])

  const load = useCallback(() => {
    const window = agendaWindow()
    setState({ kind: 'loading' })

    // Paint the last agenda for this exact day and calendar set, if there is
    // one, then let the live fetch below replace it. It only fills the gap
    // while loading and never stands in for the real answer.
    void trpc.google.agendaCached
      .query(window)
      .then((events) => {
        if (events !== null && events.length > 0) {
          setState((current) => (current.kind === 'loading' ? { kind: 'ready', events } : current))
        }
      })
      .catch(() => {})

    void trpc.google.agenda
      .query(window)
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
  useEffect(loadCalendars, [loadCalendars])

  /**
   * Switch a calendar on or off: optimistic in the list, then a reload so the
   * events follow immediately. Persisted in main, which is also where the agent
   * reads it.
   */
  const toggleCalendar = (calendar: CalendarChoice, enabled: boolean) => {
    setCalendars((previous) => previous.map((c) => (c.id === calendar.id ? { ...c, enabled } : c)))
    void trpc.google.setCalendar
      .mutate({ id: calendar.id, enabled })
      .then(load)
      // Put the checkbox back rather than leaving it lying about what main holds.
      .catch(() => loadCalendars())
  }

  /**
   * Make a task out of an event. The event's Google permalink goes in the
   * **body** as an ordinary markdown link (D67), no frontmatter field: "which
   * tasks reference this event" is a grep for the URL.
   */
  const createTask = async (event: CalendarEvent) => {
    if (remote === null) return
    setCreating(eventKey(event))
    try {
      const { path } = await trpc.tasks.create.mutate({
        remote,
        title: event.title,
        folder: '',
        // The link first, then whatever the invitation said.
        description:
          `[${event.title}](${event.htmlLink})\n` +
          (event.description === null ? '' : `\n${event.description}\n`),
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

  // Looked up rather than stored: a refresh hands back a fresh array, and the
  // old object could pin the pane to an event no longer on the agenda.
  const openEvent = state.events.find((event) => eventKey(event) === selected) ?? null

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="h-full min-h-0"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
    >
      <ResizablePanel id="agenda-list" defaultSize={480} minSize={320}>
        <div className="flex h-full min-h-0 flex-col">
          {/* No "Agenda" heading: the tab already says so. */}
          <div className="flex h-11 shrink-0 items-center justify-end gap-2 px-4">
            <div className="flex items-center gap-1">
              <CalendarPicker calendars={calendars} onToggle={toggleCalendar} />
              <Tooltip content="refresh">
                <Button variant="ghost" size="icon-xs" aria-label="refresh agenda" onClick={load}>
                  <RefreshCw size={14} />
                </Button>
              </Tooltip>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
            {byDay.size === 0 ? (
              <p className="mt-6 text-sm text-muted-foreground">
                Nothing scheduled in the next week.
              </p>
            ) : (
              [...byDay.entries()].map(([day, events]) => (
                <section key={day} className="mb-5">
                  <h3 className="sticky top-0 bg-background py-1 text-xs font-medium text-muted-foreground">
                    {dayLabel(day)}
                  </h3>
                  <ul className="space-y-1">
                    {events.map((event) => (
                      <li
                        key={eventKey(event)}
                        // An event that does not block time is dimmed.
                        className={`motion-respond group relative rounded ${event.busy ? '' : 'opacity-60'} ${
                          selected === eventKey(event) ? 'bg-secondary' : 'hover:bg-secondary/60'
                        }`}
                      >
                        {/* The row contains buttons, and a button inside a
                            button is invalid HTML. So the selection target is a
                            real button stretched behind the content, which is
                            inert so clicks fall through; the actions switch
                            pointer events back on. */}
                        <Button
                          variant="ghost"
                          aria-label={`show ${event.title}`}
                          className="absolute inset-0 h-full w-full rounded p-0 hover:bg-transparent"
                          onClick={() => setSelected(eventKey(event))}
                        />
                        <div className="pointer-events-none relative flex items-baseline gap-3 px-2 py-1.5">
                          <Swatch color={event.color} />
                          <span className="w-28 shrink-0 font-mono text-xs text-muted-foreground">
                            {timeLabel(event)}
                          </span>
                          <span className="min-w-0 flex-1">
                            {/* Someone else's event is dimmed rather than
                                hidden: it was asked for, but is not the user's. */}
                            <span
                              className={`block truncate text-sm ${event.mine ? '' : 'text-muted-foreground'}`}
                            >
                              {event.title}
                            </span>
                            {detailLine(event) !== '' && (
                              <span className="block truncate text-xs text-muted-foreground">
                                {detailLine(event)}
                              </span>
                            )}
                          </span>

                          {/* Only RSVP and Join live on the row; the rest are in
                              the detail pane. Both stay visible rather than
                              appearing on hover: a hidden-but-present button
                              inside a clickable row swallows the clicks meant to
                              select it. */}
                          <span className="pointer-events-auto flex shrink-0 items-center gap-1">
                            {event.myResponse === 'needsAction' && (
                              <Tooltip content="answer this invitation in Google Calendar">
                                <Button
                                  variant="secondary"
                                  size="xs"
                                  aria-label={`answer ${event.title} in Google Calendar`}
                                  onClick={() => void window.holi.openExternal(event.htmlLink)}
                                >
                                  RSVP
                                </Button>
                              </Tooltip>
                            )}
                            {event.conferenceUrl !== null && (
                              <Tooltip content="join the meeting">
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  aria-label={`join ${event.title}`}
                                  onClick={() =>
                                    void window.holi.openExternal(event.conferenceUrl!)
                                  }
                                >
                                  <Video size={14} />
                                </Button>
                              </Tooltip>
                            )}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              ))
            )}
          </div>
        </div>
      </ResizablePanel>

      <ResizableHandle />

      <ResizablePanel id="agenda-detail" minSize={260}>
        {openEvent === null ? (
          <Placeholder>Pick an event to read the invitation.</Placeholder>
        ) : (
          <EventDetail
            event={openEvent}
            canCreateTask={remote !== null}
            creating={creating === eventKey(openEvent)}
            onCreateTask={() => void createTask(openEvent)}
          />
        )}
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

/**
 * One event, at the length a row cannot hold: the description, plus the
 * metadata `detailLine` has to drop to fit on a row.
 */
function EventDetail({
  event,
  canCreateTask,
  creating,
  onCreateTask,
}: {
  event: CalendarEvent
  canCreateTask: boolean
  creating: boolean
  onCreateTask: () => void
}): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-end gap-1 px-4">
        {event.conferenceUrl !== null && (
          <Tooltip content="join the meeting">
            <Button
              variant="secondary"
              size="xs"
              className="mr-auto gap-1"
              onClick={() => void window.holi.openExternal(event.conferenceUrl!)}
            >
              <Video size={13} />
              Join
            </Button>
          </Tooltip>
        )}
        <Tooltip content="make a task linking this event">
          <Button
            variant="secondary"
            size="xs"
            disabled={!canCreateTask || creating}
            onClick={onCreateTask}
          >
            {creating ? 'Creating…' : 'Task'}
          </Button>
        </Tooltip>
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
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        {/* Wrapped, not truncated: the one place a long title fits. */}
        <h3 className="text-sm font-medium">{event.title}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {longDayLabel(event)} · {timeLabel(event)}
        </p>

        <dl className="mt-3 space-y-1.5">
          <Fact icon={<Swatch color={event.color} />}>
            {event.calendarName}
            {!event.mine && <span className="text-muted-foreground"> · subscribed</span>}
          </Fact>
          {KIND_LABELS[event.kind] !== undefined && (
            <Fact icon={<CalendarDays size={13} />}>{KIND_LABELS[event.kind]}</Fact>
          )}
          {event.recurring && <Fact icon={<Repeat size={13} />}>repeats</Fact>}
          {/* On the row this is only a dimming; here it is said in words. */}
          {!event.busy && <Fact icon={<CalendarDays size={13} />}>does not block time</Fact>}
          {event.location !== undefined && event.location !== '' && (
            <Fact icon={<MapPin size={13} />}>{event.location}</Fact>
          )}
          {event.organizer !== null && <Fact icon={<User size={13} />}>{event.organizer}</Fact>}
          {event.attendeeCount > 1 && (
            <Fact icon={<Users size={13} />}>{event.attendeeCount} people</Fact>
          )}
        </dl>

        {event.description !== null && event.description.trim() !== '' && (
          <div className="mt-4 border-t border-divider pt-3">
            {/* Whoever sent the invitation wrote this, so all of it goes down
                the same sandboxed path a mail body does. */}
            <SandboxedHtml
              html={descriptionHtml(event.description)}
              label={`description of ${event.title}`}
            />
          </div>
        )}
      </div>
    </div>
  )
}

/** One line of event metadata: an icon for the kind of fact, and the fact. */
function Fact({
  icon,
  children,
}: {
  icon: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 text-xs">
      <dt className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
        {icon}
      </dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

/**
 * Which calendars this agenda draws from. Yours are listed separately from
 * subscribed ones: a Workspace account accumulates colleagues, rooms and
 * birthday calendars, and flattening them all makes "what am I doing today"
 * unanswerable. The swatch is Google's own colour for the calendar.
 */
function CalendarPicker({
  calendars,
  onToggle,
}: {
  calendars: CalendarChoice[]
  onToggle: (calendar: CalendarChoice, enabled: boolean) => void
}) {
  if (calendars.length === 0) return null

  const mine = calendars.filter((c) => c.mine)
  const others = calendars.filter((c) => !c.mine)
  const off = calendars.filter((c) => !c.enabled).length

  const item = (calendar: CalendarChoice) => (
    <DropdownMenuCheckboxItem
      key={calendar.id}
      checked={calendar.enabled}
      // Radix closes on select by default; keep it open for multiple ticks.
      onSelect={(event) => event.preventDefault()}
      onCheckedChange={(checked) => onToggle(calendar, checked)}
    >
      <span className="flex min-w-0 items-center gap-2">
        <Swatch color={calendar.color} />
        <span className="truncate">{calendar.name}</span>
      </span>
    </DropdownMenuCheckboxItem>
  )

  return (
    <DropdownMenu>
      <Tooltip content="which calendars this agenda shows">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="xs" className="gap-1" aria-label="choose calendars">
            calendars
            {off > 0 && <span className="text-muted-foreground">({calendars.length - off})</span>}
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="end" className="max-w-72">
        <DropdownMenuLabel>Your calendars</DropdownMenuLabel>
        {mine.map(item)}
        {others.length > 0 && (
          <>
            <DropdownMenuSeparator />
            {/* "Subscribed" is Google's word; these are off until asked for. */}
            <DropdownMenuLabel>Subscribed</DropdownMenuLabel>
            {others.map(item)}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A calendar's colour. An inline style because the value is Google's, not a
 *  token — the arbitrary-colour ban is about hard-coded literals in class
 *  names, and there is no token that could stand for "Jane's calendar". */
function Swatch({ color }: { color: string | null }) {
  return (
    <span
      aria-hidden
      className={`size-2.5 shrink-0 rounded-[2px] ${color === null ? 'bg-muted-foreground' : ''}`}
      style={color === null ? undefined : { background: color }}
    />
  )
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}
