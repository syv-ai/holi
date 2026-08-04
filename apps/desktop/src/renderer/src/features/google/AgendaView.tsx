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
 *
 * **A list and a detail pane**, because a row cannot hold an invitation. The
 * row answers "what am I doing" — a line of it, scannable down a week. The
 * detail answers "what is this", which is mostly the description: the dial-in,
 * the agenda, the document links. That was previously reachable only by turning
 * the event into a task, which is a strange price to pay for reading it.
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

/**
 * The second line of a row: what this block is, whose it is, and how big.
 *
 * Ordered by how often it settles a question at a glance — an out-of-office
 * that reads like a meeting is how someone gets double-booked on leave, and
 * "12 people" is the difference between a meeting you can skip and one you
 * cannot. The organizer is named only for someone else's calendar, where
 * "who called this" is not already obvious.
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
 * Does this description need rendering as markup?
 *
 * Google Calendar descriptions are HTML — Meet and Zoom write whole dial-in
 * blocks of it, and Google's own UI renders them as markup — but a description
 * typed as plain prose is common too, and putting three lines of it through an
 * iframe would collapse its newlines.
 *
 * Both ways of being wrong are safe, which is why a cheap test is enough: prose
 * mistaken for markup loses its line breaks, and markup mistaken for prose shows
 * as visible tags. Neither renders anything; the untrusted path is the frame,
 * and the frame is what this chooses *into*.
 */
function looksLikeHtml(description: string): boolean {
  return /<[a-z][^>]*>/i.test(description)
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
    // Failure here is not worth a surface of its own: the agenda's own error
    // state already covers "Google is unreachable", and a picker that silently
    // stays empty is better than two error messages about the same outage.
    void trpc.google.calendars
      .query()
      .then(setCalendars)
      .catch(() => setCalendars([]))
  }, [])

  const load = useCallback(() => {
    const window = agendaWindow()
    setState({ kind: 'loading' })

    // Paint the last agenda for this exact day and calendar set, if there is
    // one — then let the live fetch below replace it. Never a request, and
    // never a substitute for the real answer: a stale agenda shown *instead of*
    // a fresh one is worse than a slow one, so this only fills the gap.
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
   * Switch a calendar on or off.
   *
   * Optimistic in the list, then a reload of the agenda — the toggle is a
   * statement about which calendars exist for the user at all, so the events
   * have to follow it immediately or the checkbox appears not to have worked.
   * It is persisted in main, which is also where the agent reads it.
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
   * Make a task out of an event.
   *
   * The event's Google permalink goes in the **body**, as an ordinary markdown
   * link (D67) — no frontmatter field, nothing machine-owned. That is the whole
   * representation; "which tasks reference this event" is a grep for the URL.
   */
  const createTask = async (event: CalendarEvent) => {
    if (remote === null) return
    setCreating(eventKey(event))
    try {
      const { path } = await trpc.tasks.create.mutate({
        remote,
        title: event.title,
        folder: '',
        // The link first, then whatever the invitation actually said — a task
        // made from a board call is worth opening because the dial-in and the
        // agenda came with it, not because it repeats the title.
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

  // Looked up rather than stored: a refresh, or switching a calendar off, hands
  // back a fresh array, and holding the old object would pin the pane to an
  // event that may no longer be on the agenda. Gone means the pane empties,
  // still there means it stays put across a reload.
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
          <div className="flex h-11 shrink-0 items-center justify-between gap-2 px-4">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <CalendarDays size={15} />
              Agenda
            </h2>
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
                        // An event that does not block time is on the calendar
                        // without claiming any: an FYI, a webinar someone forwarded.
                        // Dimming says "this is not why your day is full".
                        className={`group relative rounded ${event.busy ? '' : 'opacity-60'} ${
                          selected === eventKey(event) ? 'bg-secondary' : 'hover:bg-secondary/60'
                        }`}
                      >
                        {/* The whole row selects, but a row also *contains*
                            buttons, and a button inside a button is invalid
                            HTML that React renders anyway and browsers resolve
                            inconsistently. So the selection target is a real
                            button stretched behind the content: right
                            semantics, focusable, no nesting. The content is
                            inert so clicks fall through to it, and the actions
                            switch pointer events back on. */}
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
                                hidden: it is on the agenda because it was asked
                                for, but it is not something the user is doing. */}
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

                          {/* Two actions survive on the row, and only two.
                              Opening in Google and making a task both mean "I
                              have decided about this one event" — which is when
                              the detail pane is already open, so they moved
                              there and the row keeps its width for the title.
                              These two did not: an unanswered invitation is the
                              one row on an agenda that is a task rather than a
                              fact, and joining is the most-clicked thing on any
                              agenda. Both stay visible rather than appearing on
                              hover — a hidden-but-present button inside a row
                              that is itself clickable swallows the clicks meant
                              to select it. */}
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
 * One event, at the length a row cannot hold.
 *
 * The description is the reason this pane exists — it is where the dial-in, the
 * agenda and the document links actually live, and until now the only way to
 * read one was to turn the event into a task and open that. Everything above it
 * is the metadata `detailLine` has to drop to fit on a row.
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
        {/* Wrapped, not truncated. A row has to cut a long title; this is the
            one place the whole thing fits, which is half the point of a pane. */}
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
          {/* Said out loud here, where there is room for the words. On the row
              this is only a dimming, which tells you something is different
              without telling you what. */}
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
          <div className="mt-4 border-t border-border/50 pt-3">
            {looksLikeHtml(event.description) ? (
              // Whoever sent the invitation wrote this markup, so it goes down
              // the same sandboxed path a mail body does — see `SandboxedHtml`.
              <SandboxedHtml html={event.description} label={`description of ${event.title}`} />
            ) : (
              <p className="whitespace-pre-wrap break-words text-sm">{event.description}</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** One line of event metadata: an icon that says which kind of fact it is, and
 *  the fact. A `<dl>` because that is what these are — labelled values whose
 *  label happens to be drawn rather than written. */
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
 * Which calendars this agenda draws from.
 *
 * Yours are listed first and separately from the ones you are subscribed to,
 * because that is the distinction the list exists to make: a Workspace account
 * accumulates colleagues, rooms and birthday calendars, and flattening all of
 * them into one agenda is what made "what am I doing today" unanswerable.
 *
 * The swatch is Google's own colour for the calendar, so a row here and a row
 * in Google Calendar are recognisably the same thing.
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
      // Radix closes on select by default; ticking three colleagues one at a
      // time through three menu openings is the wrong interaction for this.
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
            {/* Named for what they are. "Subscribed" is the word Google uses,
                and it is why these are off until asked for. */}
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
