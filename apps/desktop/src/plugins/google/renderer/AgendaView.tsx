/**
 * The agenda — your Google Calendar for the next few days, and the one place
 * an event becomes a task.
 *
 * **Account-wide, not vault content**: this shows the same events
 * whichever vault is open. Creating a task from an event writes a *task file*,
 * not a calendar event.
 *
 * Fetched on open and on refresh, never polled. A cached agenda may paint
 * first, but the live fetch always replaces it.
 *
 * **A list and a detail pane**, because a row cannot hold an invitation: the
 * detail is mostly the description (the dial-in, the agenda, the links).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  MapPin,
  RefreshCw,
  Repeat,
  User,
  Users,
  Video,
} from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import { EmptyState, LoadingRows, PaneToolbar } from '@/composites'
import {
  Button,
  Dialog,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icon,
  IconButton,
  PillGroup,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  Tooltip,
} from '@/primitives'
import { SandboxedHtml } from './SandboxedHtml'
import {
  activeRemoteAtom,
  openNoteTabAtom,
  openSettingsSectionAtom,
  useGlobalPanelLayout,
  useHasCapability,
} from '@/plugin-api'
import { googleCap } from './account'
import { TASKS_CREATE, tasksCap } from './tasks'
import { MonthView } from './MonthView'
import { NewEventDialog, type NewEventValues } from './NewEventDialog'
import { eventDays, monthWindow, shiftMonth } from './month-days'
import { localDate } from '@holi/shared'

/** The agenda is a month to look at and create in, or the next week as a list
 *  with each invitation beside it. */
type View = 'month' | 'list'

const VIEW_OPTIONS = [
  { value: 'month', label: 'Month' },
  { value: 'list', label: 'List' },
] as const

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
function agendaWindow(): { from: string; to: string } {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + DAYS_AHEAD)
  return { from: start.toISOString(), to: end.toISOString() }
}

/** tRPC's verdict, as `ipcLink` rebuilt it onto `err.data.code`. */
function codeOf(error: unknown): string | null {
  const data = (error as { data?: { code?: unknown } } | null)?.data
  return typeof data?.code === 'string' ? data.code : null
}

/** `2026-08-04` for a timed instant or an all-day date, in local time. */
function dayKeyOf(event: CalendarEvent): string {
  if (event.allDay) return event.start.slice(0, 10)
  return localDate(new Date(event.start))
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
    // Said in words: the row no longer dims a whole event that takes no time.
    event.busy ? undefined : 'free',
    event.calendarName || undefined,
    event.location,
    event.attendeeCount > 1 ? `${event.attendeeCount} people` : undefined,
    event.organizer !== null && !event.mine ? event.organizer : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
}

function timeLabel(event: CalendarEvent): string {
  if (event.allDay) return 'All day'
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

export function AgendaView({
  initialView = 'list',
}: {
  initialView?: View
} = {}) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [view, setView] = useState<View>(initialView)
  const [cursor, setCursor] = useState<[number, number]>(() => {
    const now = new Date()
    return [now.getFullYear(), now.getMonth() + 1]
  })
  /** The day a new event is being started on. */
  const [newDay, setNewDay] = useState<string | null>(null)
  /** The day whose events are listed in full ("+N more"). */
  const [moreDay, setMoreDay] = useState<string | null>(null)
  const [year, month] = cursor
  const [calendars, setCalendars] = useState<CalendarChoice[]>([])
  const remote = useAtomValue(activeRemoteAtom)
  const openNote = useSetAtom(openNoteTabAtom)
  const [creating, setCreating] = useState<string | null>(null)
  /** Offered only in a vault that runs tasks. */
  const canCreateTask = useHasCapability(TASKS_CREATE) && remote !== null
  /** Which row the detail pane is showing, by `eventKey`. */
  const [selected, setSelected] = useState<string | null>(null)
  /** Account-scoped, not per-vault: the agenda is the same calendar in every
   *  vault, and opens with no vault at all. See `useGlobalPanelLayout`. */
  const layout = useGlobalPanelLayout('agenda')
  const openSettings = useSetAtom(openSettingsSectionAtom)

  const loadCalendars = useCallback(() => {
    // No error surface of its own: the agenda's error state already covers
    // "Google is unreachable", and one message per outage is enough.
    if (remote === null) return
    void googleCap
      .calendars(remote)
      .then(setCalendars)
      .catch(() => setCalendars([]))
  }, [remote])

  /** The newest load: an answer for a month already paged away from, or a
   *  view already left, arrives late and is dropped. */
  const latestLoad = useRef(0)

  const load = useCallback(() => {
    const asked = ++latestLoad.current
    const stillAsked = (): boolean => asked === latestLoad.current
    if (remote === null) {
      setState({ kind: 'disconnected' })
      return
    }
    const window = view === 'month' ? monthWindow(year, month) : agendaWindow()
    // Paging keeps the grid it has drawn until the new month answers.
    setState((current) => (current.kind === 'ready' ? current : { kind: 'loading' }))

    // Paint the last agenda for this exact day and calendar set, if there is
    // one, then let the live fetch below replace it. It only fills the gap
    // while loading and never stands in for the real answer.
    void googleCap
      .agendaCached(remote, window)
      .then((events) => {
        if (stillAsked() && events !== null && events.length > 0) {
          setState((current) => (current.kind === 'loading' ? { kind: 'ready', events } : current))
        }
      })
      .catch(() => {})

    void googleCap
      .agenda(remote, window)
      .then((events) => {
        if (stillAsked()) setState({ kind: 'ready', events })
      })
      .catch((err: unknown) => {
        if (!stillAsked()) return
        const message = err instanceof Error ? err.message : 'Could not load your agenda.'
        // A missing/expired connection is not an error to apologise for — it is
        // a state with an obvious next action, so it gets its own surface.
        const code = codeOf(err)
        setState(
          code === 'UNAUTHORIZED' ||
            code === 'PRECONDITION_FAILED' ||
            /not connected|connect Google|no longer valid|not configured/i.test(message)
            ? { kind: 'disconnected' }
            : { kind: 'error', message },
        )
      })
  }, [remote, view, year, month])

  useEffect(load, [load])
  useEffect(loadCalendars, [loadCalendars])

  /**
   * Switch a calendar on or off: optimistic in the list, then a reload so the
   * events follow immediately. Persisted in main, which is also where the agent
   * reads it.
   */
  const toggleCalendar = (calendar: CalendarChoice, enabled: boolean) => {
    setCalendars((previous) => previous.map((c) => (c.id === calendar.id ? { ...c, enabled } : c)))
    if (remote === null) return
    void googleCap
      .setCalendar(remote, { id: calendar.id, enabled })
      .then(load)
      // Put the checkbox back rather than leaving it lying about what main holds.
      .catch(() => loadCalendars())
  }

  /**
   * Make a task out of an event. The event's Google permalink goes in the
   * **body** as an ordinary markdown link, no frontmatter field: "which
   * tasks reference this event" is a grep for the URL.
   */
  const createTask = async (event: CalendarEvent) => {
    if (remote === null) return
    setCreating(eventKey(event))
    try {
      const { path } = await tasksCap.create(remote, {
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

  /** Make the event, then read the month again so it is on the grid. */
  const createEvent = async (values: NewEventValues): Promise<void> => {
    if (remote === null) throw new Error('No vault is open.')
    await googleCap.schedule(remote, {
      title: values.title,
      start: values.start,
      end: values.end,
      ...(values.allDay ? { 'all-day': true } : {}),
      ...(values.location === '' ? {} : { location: values.location }),
    })
    load()
  }

  if (state.kind === 'loading') {
    return <LoadingRows label="Loading your agenda" />
  }

  if (state.kind === 'disconnected') {
    return (
      <EmptyState
        icon={CalendarDays}
        title="Google isn’t connected"
        description="Connect an account to see your calendar here."
        action={{ label: 'Open Connections', onClick: () => openSettings('connections') }}
      />
    )
  }

  if (state.kind === 'error') {
    return (
      <EmptyState
        role="alert"
        title="Couldn’t load your agenda"
        description={state.message}
        action={{ label: 'Try again', icon: RefreshCw, onClick: load }}
      />
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

  /**
   * One header for both views, so switching does not move the switch or
   * change the header's height: the switch leads, the month's name follows it
   * in month view, and the paging, calendars and refresh sit at the end.
   */
  const toolbar = (
    <PaneToolbar>
      <PillGroup
        label="Agenda view"
        options={VIEW_OPTIONS}
        isOn={(choice) => choice === view}
        onPick={setView}
        className="flex-nowrap"
      />
      {view === 'month' && (
        <h2 className="ml-2 truncate text-sm font-medium tabular-nums" aria-live="polite">
          {new Date(year, month - 1, 1).toLocaleDateString(undefined, {
            month: 'long',
            year: 'numeric',
          })}
        </h2>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {view === 'month' && (
          <>
            <IconButton
              icon={ChevronLeft}
              label="Previous month"
              onClick={() => setCursor(shiftMonth(year, month, -1))}
            />
            <Button
              variant="secondary"
              size="xs"
              onClick={() => {
                const now = new Date()
                setCursor([now.getFullYear(), now.getMonth() + 1])
              }}
            >
              Today
            </Button>
            <IconButton
              icon={ChevronRight}
              label="Next month"
              onClick={() => setCursor(shiftMonth(year, month, 1))}
            />
          </>
        )}
        <CalendarPicker calendars={calendars} onToggle={toggleCalendar} />
        <IconButton icon={RefreshCw} label="Refresh agenda" tooltip="Refresh" onClick={load} />
      </div>
    </PaneToolbar>
  )

  if (view === 'month') {
    const dayEvents =
      moreDay === null ? [] : state.events.filter((e) => eventDays(e).includes(moreDay))
    return (
      <div className="flex h-full min-h-0 flex-col">
        {toolbar}
        <div className="min-h-0 flex-1">
          <MonthView
            year={year}
            month={month}
            events={state.events}
            onPickDay={setNewDay}
            onPickEvent={(event) => setSelected(eventKey(event as CalendarEvent))}
            onMore={setMoreDay}
          />
        </div>

        <NewEventDialog day={newDay} onClose={() => setNewDay(null)} onCreate={createEvent} />

        <Dialog open={openEvent !== null} onClose={() => setSelected(null)} size="md">
          {openEvent !== null && (
            <>
              <Dialog.Header>{openEvent.title}</Dialog.Header>
              <Dialog.Body>
                <div className="max-h-[55vh] min-h-0 overflow-y-auto">
                  <EventDetail
                    event={openEvent}
                    canCreateTask={canCreateTask}
                    creating={creating === eventKey(openEvent)}
                    onCreateTask={() => void createTask(openEvent)}
                  />
                </div>
              </Dialog.Body>
            </>
          )}
        </Dialog>

        <Dialog open={moreDay !== null} onClose={() => setMoreDay(null)} size="sm">
          {moreDay !== null && (
            <>
              <Dialog.Header>{dayLabel(moreDay)}</Dialog.Header>
              <Dialog.Body>
                <ul className="flex flex-col gap-1">
                  {dayEvents.map((event) => (
                    <li key={eventKey(event)}>
                      <Button
                        variant="ghost"
                        className="h-auto w-full justify-start gap-3 px-2 py-1.5 text-left font-normal"
                        onClick={() => {
                          setMoreDay(null)
                          setSelected(eventKey(event))
                        }}
                      >
                        <Swatch color={event.color} />
                        <span className="w-24 shrink-0 font-mono text-xs text-muted-foreground">
                          {timeLabel(event)}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm">{event.title}</span>
                      </Button>
                    </li>
                  ))}
                </ul>
              </Dialog.Body>
              <Dialog.Footer>
                <Button
                  onClick={() => {
                    setNewDay(moreDay)
                    setMoreDay(null)
                  }}
                >
                  New event
                </Button>
              </Dialog.Footer>
            </>
          )}
        </Dialog>
      </div>
    )
  }

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
          {toolbar}

          {byDay.size === 0 ? (
            <EmptyState
              icon={CalendarDays}
              title="Nothing scheduled in the next week"
              description="Events from the calendars you show appear here."
              action={{ label: 'Show the month', onClick: () => setView('month') }}
            />
          ) : (
            // `px-2`, not the pane's `px-4`: each row's fill bleeds 8px past
            // its text, so the swatch and the day headings land on the
            // toolbar's 16px edge.
            <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-2 pb-6">
              {[...byDay.entries()].map(([day, events]) => (
                <section key={day}>
                  <h3 className="sticky top-0 bg-background px-2 py-1 text-xs font-medium text-muted-foreground">
                    {dayLabel(day)}
                  </h3>
                  <ul className="flex flex-col gap-1">
                    {events.map((event) => (
                      <li
                        key={eventKey(event)}
                        data-busy={event.busy ? '' : undefined}
                        className={`motion-respond group relative rounded ${
                          selected === eventKey(event)
                            ? 'bg-foreground/[0.06]'
                            : 'hover:bg-foreground/[0.04]'
                        }`}
                      >
                        {/* The row contains buttons, and a button inside a
                            button is invalid HTML. So the selection target is a
                            real button stretched behind the content, which is
                            inert so clicks fall through; the actions switch
                            pointer events back on. */}
                        <Button
                          variant="ghost"
                          aria-label={`Show ${event.title}`}
                          className="absolute inset-0 h-full w-full rounded p-0 hover:bg-transparent"
                          onClick={() => setSelected(eventKey(event))}
                        />
                        <div className="pointer-events-none relative flex items-baseline gap-3 px-2 py-1.5">
                          <Swatch color={event.color} />
                          <span className="w-28 shrink-0 font-mono text-xs text-muted-foreground">
                            {timeLabel(event)}
                          </span>
                          <span className="min-w-0 flex-1">
                            {/* Someone else's event, and one that does not
                                block time, dim their title only: the meta
                                under it is already muted, and dimming it again
                                would drop it below a readable contrast. */}
                            {/* Truncated here; the detail pane wraps it in full. */}
                            <span
                              className={`block truncate text-sm ${
                                event.mine && event.busy ? '' : 'text-muted-foreground'
                              }`}
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
                              <Tooltip content="Answer this invitation in Google Calendar">
                                <Button
                                  variant="secondary"
                                  size="xs"
                                  aria-label={`Answer ${event.title} in Google Calendar`}
                                  onClick={() => void window.holi.openExternal(event.htmlLink)}
                                >
                                  RSVP
                                </Button>
                              </Tooltip>
                            )}
                            {event.conferenceUrl !== null && (
                              <IconButton
                                icon={Video}
                                label={`Join ${event.title}`}
                                tooltip="Join the meeting"
                                onClick={() => void window.holi.openExternal(event.conferenceUrl!)}
                              />
                            )}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </ResizablePanel>

      <ResizableHandle />

      <ResizablePanel id="agenda-detail" minSize={260}>
        {openEvent === null ? (
          <EmptyState icon={CalendarDays} title="Pick an event to read the invitation" />
        ) : (
          <EventDetail
            event={openEvent}
            canCreateTask={canCreateTask}
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
      <PaneToolbar className="justify-end">
        {event.conferenceUrl !== null && (
          <Tooltip content="Join the meeting">
            <Button
              variant="secondary"
              size="xs"
              className="mr-auto gap-1"
              onClick={() => void window.holi.openExternal(event.conferenceUrl!)}
            >
              <Icon icon={Video} size="sm" />
              Join
            </Button>
          </Tooltip>
        )}
        {canCreateTask && (
          <Tooltip content="Make a task linking this event">
            <Button variant="secondary" size="xs" disabled={creating} onClick={onCreateTask}>
              {creating ? 'Creating…' : 'Task'}
            </Button>
          </Tooltip>
        )}
        <IconButton
          icon={ExternalLink}
          label={`Open ${event.title} in Google Calendar`}
          tooltip="Open in Google Calendar"
          onClick={() => void window.holi.openExternal(event.htmlLink)}
        />
      </PaneToolbar>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        {/* Wrapped, not truncated: the one place a long title fits. */}
        <h3 className="text-sm font-medium text-pretty break-words">{event.title}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {longDayLabel(event)} · {timeLabel(event)}
        </p>

        <dl className="mt-3 flex flex-col gap-1.5">
          <Fact icon={<Swatch color={event.color} />}>
            {event.calendarName}
            {!event.mine && <span className="text-muted-foreground"> · Subscribed</span>}
          </Fact>
          {KIND_LABELS[event.kind] !== undefined && (
            <Fact icon={<Icon icon={CalendarDays} size="sm" tone="muted" />}>
              {sentence(KIND_LABELS[event.kind]!)}
            </Fact>
          )}
          {event.recurring && (
            <Fact icon={<Icon icon={Repeat} size="sm" tone="muted" />}>Repeats</Fact>
          )}
          {/* On the row this is only a dimming; here it is said in words. */}
          {!event.busy && (
            <Fact icon={<Icon icon={CalendarDays} size="sm" tone="muted" />}>
              Free: doesn’t block time
            </Fact>
          )}
          {event.location !== undefined && event.location !== '' && (
            <Fact icon={<Icon icon={MapPin} size="sm" tone="muted" />}>{event.location}</Fact>
          )}
          {event.organizer !== null && (
            <Fact icon={<Icon icon={User} size="sm" tone="muted" />}>{event.organizer}</Fact>
          )}
          {event.attendeeCount > 1 && (
            <Fact icon={<Icon icon={Users} size="sm" tone="muted" />}>
              {event.attendeeCount} people
            </Fact>
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
      <Tooltip content="Which calendars this agenda shows">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="xs" className="gap-1">
            Calendars
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

/** A label that starts a line: `focus time` → `Focus time`. */
function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
