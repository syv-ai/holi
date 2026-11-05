/**
 * Google Calendar as ReUI's `event-calendar-3` block: a rail with the
 * calendars, a mini month and the selected day, beside ReUI's event calendar
 * in day, week, month and agenda views, and a card that reads, creates and
 * edits an event.
 *
 * **Account-wide, not vault content**, as the Agenda is: the same events
 * whichever vault is open, fetched for the visible range on open, on paging
 * and on refresh, never polled. The renderer paints a move first and Google's
 * answer corrects it.
 *
 * What it may change is what the agent may: the person's own events on the
 * primary calendar with nobody invited, since any other change emails people.
 * Everything else reads, and opens in Google Calendar.
 *
 * It owns its layout (`h-full`), so whatever mounts it gives it a sized box.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  EventCalendar,
  type EventCalendarRenderEventProps,
} from '@/components/ui/event-calendar/event-calendar'
import { EventCalendarContent } from '@/components/ui/event-calendar/event-calendar-content'
import { EVENT_CALENDAR_FADE_TRUNCATE } from '@/components/ui/event-calendar/event-calendar-event'
import {
  EventCalendarNav,
  EventCalendarToolbar,
} from '@/components/ui/event-calendar/event-calendar-nav'
import type {
  EventCalendarOccurrence,
  EventCalendarProposedUpdate,
  EventCalendarSlotDraft,
  EventCalendarSlotInfo,
} from '@/components/ui/event-calendar/event-calendar-types'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { toast } from 'sonner'
import {
  activeRemoteAtom,
  cn,
  openNoteTabAtom,
  openSettingsSectionAtom,
  useHasCapability,
  openExternal,
} from '@/plugin-api'
import { localDate } from '@holi/shared'
import { addMinutes, setHours, startOfDay, subDays } from 'date-fns'
import {
  CalendarDaysIcon,
  MapPinIcon,
  PlusIcon,
  RefreshCwIcon,
  RepeatIcon,
  UsersIcon,
} from 'lucide-react'
import { useGoogleAccount } from '../account'
import {
  FALLBACK_COLOR,
  midnightAfter,
  toCalendarItem,
  useGoogleCalendar,
  type GoogleEventData,
} from '../calendar-data'
import { messageOf } from '../google-errors'
import { TASKS_CREATE, tasksCreateCap } from '../tasks-cap'
import { CalendarRail } from './calendar-rail'
import { CalendarsMenu } from './calendars-menu'
import { WEEK_STARTS_ON, hhmm, timeOf } from './calendar-format'
import { EventCard, type EventCardAnchor, type EventDraft, type EventCardState } from './event-card'

type Occurrence = EventCalendarOccurrence<GoogleEventData>

function captureCardAnchor(
  element: HTMLElement,
  rect = element.getBoundingClientRect(),
): EventCardAnchor {
  const root = element.closest<HTMLElement>('[data-slot="event-calendar"]')
  const fallback =
    root?.querySelector<HTMLElement>('[data-slot="event-calendar-more"]') ??
    root?.querySelector<HTMLElement>('button') ??
    null
  return { rect, element, fallback }
}

/** Quick-add ("New event") lands on a working hour. Slot clicks bring their
 *  own real time and never go through here. */
const QUICK_ADD_HOUR = 9
const quickAddStart = (day: Date) => setHours(startOfDay(day), QUICK_ADD_HOUR)

const errorToast = (message: string) =>
  toast.error(message, { classNames: { icon: 'text-destructive' } })

/** Why an event cannot be moved, in the words its card uses. */
const lockedReason = (title: string, data: GoogleEventData | undefined): string =>
  (data?.attendeeCount ?? 0) > 0
    ? `"${title}" has guests: move it in Google Calendar, which emails them.`
    : `"${title}" is not on your calendar: move it in Google Calendar.`

const toDate = (day: string, time: string) => new Date(`${day}T${time}:00`)

/** Hydrate the edit buffer from a clicked occurrence. */
function draftFromOccurrence(occurrence: Occurrence): EventDraft {
  const event = occurrence.event
  const { start, end } = occurrence
  const allDay = occurrence.allDay
  const lastDay = allDay ? subDays(end, 1) : end
  return {
    key: event.id,
    googleId: event.data?.googleId,
    title: event.title,
    location: event.data?.location ?? '',
    date: localDate(start),
    dateEnd: localDate(lastDay < start ? start : lastDay),
    start: hhmm(start),
    end: hhmm(end),
    allDay,
    calendarName: event.data?.calendarName ?? '',
    color: event.color ?? FALLBACK_COLOR,
    data: event.data,
  }
}

export function CalendarView(): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const { account } = useGoogleAccount()
  const calendar = useGoogleCalendar(remote)
  useEffect(() => {
    const nextIdentity = `${remote ?? ''}:${account?.email ?? ''}`
    if (contextIdentity.current !== nextIdentity) {
      contextIdentity.current = nextIdentity
      cardIdentity.current += 1
      pending.current = false
      setSaving(false)
      setCard(null)
      setCardAnchor(null)
      setError(null)
    }
    return () => {
      cardIdentity.current += 1
    }
  }, [remote, account?.email])
  const openSettings = useSetAtom(openSettingsSectionAtom)
  const openNote = useSetAtom(openNoteTabAtom)
  const canCreateTask = useHasCapability(TASKS_CREATE) && remote !== null

  const [card, setCard] = useState<EventCardState | null>(null)
  const [cardAnchor, setCardAnchor] = useState<EventCardAnchor | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const cardIdentity = useRef(0)
  const pending = useRef(false)
  const contextIdentity = useRef(`${remote ?? ''}:${account?.email ?? ''}`)
  // The visible date, shared by the rail's mini calendar and the grid. One
  // source of truth: the mini calendar and grid nav both write it, both read it.
  const [date, setDate] = useState<Date>(() => new Date())

  // The primary calendar is the account's address: the one Holi writes to.
  const ownCalendarId = account?.email ?? null
  const ownCalendar = calendar.calendars.find((c) => c.id === ownCalendarId)

  const items = useMemo(() => {
    const colors = new Map(calendar.calendars.map((c) => [c.id, c.color]))
    return calendar.events.map((event) =>
      toCalendarItem(event, ownCalendarId, colors.get(event.calendarId)),
    )
  }, [calendar.events, calendar.calendars, ownCalendarId])

  // Latest-value ref so the stable callbacks below read fresh writes without
  // re-subscribing the calendar on every load.
  const calendarRef = useRef(calendar)
  calendarRef.current = calendar

  /** Live drag feedback (invalid cursor). */
  const canDropEvent = useCallback(
    (update: EventCalendarProposedUpdate<GoogleEventData>) => update.event.data?.editable === true,
    [],
  )

  /** A drag or resize: painted at once, then sent; a refusal puts it back. */
  const handleEventUpdate = useCallback((update: EventCalendarProposedUpdate<GoogleEventData>) => {
    const data = update.event.data
    if (data?.editable !== true) {
      errorToast(lockedReason(update.event.title, data))
      return false
    }
    const times = { start: update.start, end: update.end, allDay: update.allDay }
    const { patchLocal, update: reschedule, reload } = calendarRef.current
    patchLocal(update.event.id, times)
    reschedule(data.googleId, times).catch((err: unknown) => {
      errorToast(messageOf(err, `Could not move "${update.event.title}".`))
      reload()
    })
    return true
  }, [])

  const handleDragBlocked = useCallback(
    (occurrence: Occurrence, info: { gesture: 'move' | 'resize'; reason: string }) => {
      if (info.reason === 'readOnly') {
        errorToast(lockedReason(occurrence.event.title, occurrence.event.data))
      }
    },
    [],
  )

  // ---- Card open helpers -------------------------------------------------
  const openCreate = useCallback(
    (start: Date, allDay = false, end?: Date, anchor?: EventCardAnchor | null) => {
      if (pending.current) return
      cardIdentity.current += 1
      setCardAnchor(anchor ?? null)
      setError(null)
      const startDay = localDate(start)
      // Slot ends are exclusive; store the inclusive last day so multi-day
      // drag-creates keep their span.
      const lastDay = end && end > start ? localDate(allDay ? subDays(end, 1) : end) : startDay
      setCard({
        mode: 'create',
        draft: {
          title: '',
          location: '',
          date: startDay,
          dateEnd: lastDay < startDay ? startDay : lastDay,
          start: allDay ? '09:00' : hhmm(start),
          // A timed quick-add defaults to 30 min so Save passes on the first try.
          end: allDay ? '10:00' : hhmm(end ?? addMinutes(start, 30)),
          allDay,
          calendarName: ownCalendar?.name ?? account?.email ?? 'Your calendar',
          color: ownCalendar?.color ?? FALLBACK_COLOR,
        },
      })
    },
    [ownCalendar, account],
  )

  const openView = useCallback(
    (occurrence: Occurrence, event?: React.MouseEvent | PointerEvent) => {
      if (pending.current) return
      cardIdentity.current += 1
      const target =
        event?.target instanceof Element
          ? event.target.closest<HTMLElement>(
              'button,[role=button],[data-slot=event-calendar-event]',
            )
          : null
      const element = event?.currentTarget instanceof HTMLElement ? event.currentTarget : target
      const rect =
        element?.getBoundingClientRect() ??
        (event ? new DOMRect(event.clientX, event.clientY, 1, 1) : new DOMRect())
      const root = element?.closest<HTMLElement>('[data-slot="event-calendar"]')
      const fallback =
        root?.querySelector<HTMLElement>('[data-slot="event-calendar-more"]') ??
        root?.querySelector<HTMLElement>('button') ??
        null
      setCardAnchor(element ? captureCardAnchor(element, rect) : { rect, element, fallback })
      setError(null)
      setCard({ mode: 'view', draft: draftFromOccurrence(occurrence) })
    },
    [],
  )

  const startEdit = useCallback(() => {
    if (pending.current) return
    setError(null)
    setCard((prev) => (prev ? { mode: 'edit', draft: prev.draft } : prev))
  }, [])

  const updateDraft = useCallback((draft: EventDraft) => {
    setCard((prev) => (prev ? { ...prev, draft } : prev))
  }, [])

  const closeCard = useCallback((open: boolean) => {
    if (!open && !pending.current) {
      cardIdentity.current += 1
      setCard(null)
      setCardAnchor(null)
      setError(null)
    }
  }, [])

  const saveDraft = async (): Promise<void> => {
    if (!card || saving) return
    const identity = cardIdentity.current
    const draft = card.draft
    const title = draft.title.trim()
    if (title === '') return setError('Give it a title.')
    const start = draft.allDay ? toDate(draft.date, '00:00') : toDate(draft.date, draft.start)
    const end = draft.allDay ? midnightAfter(draft.dateEnd) : toDate(draft.dateEnd, draft.end)
    if (end <= start) return setError('It has to end after it starts.')
    setError(null)
    pending.current = true
    setSaving(true)
    try {
      const times = { title, start, end, allDay: draft.allDay }
      if (card.mode === 'edit' && draft.googleId !== undefined) {
        await calendar.update(draft.googleId, times)
      } else {
        await calendar.create({ ...times, location: draft.location.trim() })
      }
      if (identity === cardIdentity.current) {
        setCard(null)
        setCardAnchor(null)
      }
    } catch (err) {
      if (identity === cardIdentity.current) setError(messageOf(err, 'Could not save the event.'))
    } finally {
      if (identity === cardIdentity.current) {
        pending.current = false
        setSaving(false)
      }
    }
  }

  const deleteDraft = async (): Promise<void> => {
    const googleId = card?.draft.googleId
    if (googleId === undefined || pending.current) return
    const identity = cardIdentity.current
    pending.current = true
    setSaving(true)
    try {
      await calendar.remove(googleId)
      if (identity === cardIdentity.current) {
        toast.success('Event deleted.')
        setCard(null)
        setCardAnchor(null)
      }
    } catch (err) {
      if (identity === cardIdentity.current) setError(messageOf(err, 'Could not delete the event.'))
    } finally {
      if (identity === cardIdentity.current) {
        pending.current = false
        setSaving(false)
      }
    }
  }

  /**
   * Make a task out of an event, as the Agenda does: the event's Google
   * permalink goes in the body as an ordinary markdown link.
   */
  const createTask = async (): Promise<void> => {
    const draft = card?.draft
    if (remote === null || draft?.data === undefined || pending.current) return
    const identity = cardIdentity.current
    pending.current = true
    setSaving(true)
    try {
      const { path } = await tasksCreateCap.create(remote, {
        title: draft.title,
        folder: '',
        description:
          `[${draft.title}](${draft.data.htmlLink})\n` +
          (draft.data.description === null ? '' : `\n${draft.data.description}\n`),
      })
      if (identity === cardIdentity.current) {
        setCard(null)
        setCardAnchor(null)
        openNote(path)
      }
    } catch (err) {
      if (identity === cardIdentity.current) setError(messageOf(err, 'Could not make a task.'))
    } finally {
      if (identity === cardIdentity.current) {
        pending.current = false
        setSaving(false)
      }
    }
  }

  // ---- Consumer-owned chip content (the headless contract) ----------------
  const renderEvent = useCallback(
    ({ occurrence, segment, view }: EventCalendarRenderEventProps<GoogleEventData>) => {
      const event = occurrence.event
      // strictly > 24h => a cross-day bar (matches the primitive)
      const isBar =
        occurrence.allDay ||
        occurrence.end.getTime() - occurrence.start.getTime() > 24 * 60 * 60 * 1000
      const timedBlock =
        !isBar && (view === 'week' || view === 'day' || view === 'days' || view === 'resource')
      const stacked = timedBlock && (segment.endMin ?? 0) - (segment.startMin ?? 0) >= 45
      // Free time and someone else's event read quieter, never by opacity.
      const quiet = event.data?.busy === false || event.data?.mine === false
      return (
        <>
          {!timedBlock && (
            <span
              aria-hidden="true"
              className="size-1.5 shrink-0 rounded-full bg-(--ec-event-color)"
            />
          )}
          {event.data?.recurring && (
            <RepeatIcon className="size-2.5 shrink-0 opacity-70" aria-hidden="true" />
          )}
          <span
            className={cn(
              'font-medium',
              quiet && 'text-muted-foreground',
              stacked ? EVENT_CALENDAR_FADE_TRUNCATE : 'truncate',
            )}
          >
            {event.title}
          </span>
          {!occurrence.allDay &&
            segment.isStart &&
            (view === 'month' ? (
              <span className="text-muted-foreground shrink-0 text-xs">
                {timeOf(occurrence.start)}
              </span>
            ) : (
              <span
                className={cn(
                  'text-muted-foreground hidden @[8rem]:inline',
                  stacked ? EVENT_CALENDAR_FADE_TRUNCATE : 'truncate',
                )}
              >
                {timeOf(occurrence.start)} - {timeOf(occurrence.end)}
              </span>
            ))}
        </>
      )
    },
    [],
  )

  // Agenda rows get their own renderer: a full-width list row has the space
  // for the location and the size of the meeting the grid chips cannot show.
  // This replaces the ENTIRE row, so the time column is ours to draw too.
  const renderAgendaEvent = useCallback(
    ({ occurrence }: EventCalendarRenderEventProps<GoogleEventData>) => {
      const event = occurrence.event
      const location = event.data?.location
      const people = event.data?.attendeeCount ?? 0
      return (
        <>
          <span className="text-muted-foreground w-40 shrink-0 truncate tabular-nums">
            {occurrence.allDay
              ? 'All day'
              : `${timeOf(occurrence.start)} - ${timeOf(occurrence.end)}`}
          </span>
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-(--ec-event-color)" />
          <span className="truncate text-sm font-medium">{event.title}</span>
          {event.data?.recurring && (
            <RepeatIcon className="text-muted-foreground size-2.5 shrink-0" aria-hidden="true" />
          )}
          {location && (
            <span className="text-muted-foreground hidden min-w-0 items-center gap-1 text-xs @[32rem]:flex">
              <MapPinIcon className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{location}</span>
            </span>
          )}
          {people > 1 && (
            <span className="text-muted-foreground ms-auto hidden shrink-0 items-center gap-1 text-xs tabular-nums @[26rem]:flex">
              <UsersIcon className="size-3" aria-hidden="true" />
              {people}
            </span>
          )}
        </>
      )
    },
    [],
  )

  const renderNoEvents = useCallback(
    () => (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CalendarDaysIcon />
          </EmptyMedia>
          <EmptyTitle>Nothing scheduled</EmptyTitle>
          <EmptyDescription>Events from the calendars you show appear here.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            onClick={(event) =>
              openCreate(quickAddStart(date), false, undefined, {
                rect: event.currentTarget.getBoundingClientRect(),
                element: event.currentTarget,
              })
            }
          >
            <PlusIcon className="size-4" aria-hidden="true" />
            New event
          </Button>
        </EmptyContent>
      </Empty>
    ),
    [openCreate, date],
  )

  if (calendar.status.kind === 'disconnected' || account === null) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CalendarDaysIcon />
          </EmptyMedia>
          <EmptyTitle>Google isn’t connected</EmptyTitle>
          <EmptyDescription>Connect an account to see your calendar here.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={() => openSettings('connections')}>Open Connections</Button>
        </EmptyContent>
      </Empty>
    )
  }

  const firstLoad = calendar.status.kind === 'loading'

  return (
    <TooltipProvider delayDuration={0}>
      {/* The calendar is the page: no card, inset or fill of its own, so the
          window's surface shows through and the rail's border is the only
          divider. */}
      <div className="flex h-full w-full min-w-0 flex-row overflow-hidden">
        <CalendarRail
          className="hidden w-72 shrink-0 flex-col border-e lg:flex"
          date={date}
          onDateChange={setDate}
          events={items}
          calendars={calendar.calendars}
          loading={firstLoad}
          onToggleCalendar={calendar.setCalendarEnabled}
          onOpenOccurrence={openView}
        />
        <EventCalendar
          events={items}
          date={date}
          onDateChange={setDate}
          defaultView="week"
          views={['day', 'week', 'month', 'agenda']}
          weekStartsOn={WEEK_STARTS_ON}
          loading={calendar.loading}
          navButtonSize="default"
          nowIndicator
          scrollToHour={8}
          snapDuration={15}
          scrollMode="contained"
          scrollbars="custom"
          showDayAddButton
          offDays
          onRangeChange={(info) => calendar.showRange(info.range)}
          onEventClick={(occurrence, event) => openView(occurrence, event)}
          onSlotClick={(slot: EventCalendarSlotInfo, event) =>
            openCreate(slot.date, slot.allDay, slot.end, {
              rect: event.currentTarget.getBoundingClientRect(),
              element: event.currentTarget as HTMLElement,
            })
          }
          onSelectSlot={(slot: EventCalendarSlotDraft, event) => {
            const target = event?.target instanceof HTMLElement ? event.target : null
            const rect = event ? new DOMRect(event.clientX, event.clientY, 1, 1) : null
            const root = target?.closest<HTMLElement>('[data-slot="event-calendar"]')
            const fallback =
              root?.querySelector<HTMLElement>('[data-slot="event-calendar-more"]') ??
              root?.querySelector<HTMLElement>('button') ??
              null
            openCreate(
              slot.start,
              slot.allDay,
              slot.end,
              rect ? { rect, element: target, fallback } : null,
            )
          }}
          onEventUpdate={handleEventUpdate}
          onDragBlocked={handleDragBlocked}
          canDropEvent={canDropEvent}
          renderEvent={renderEvent}
          renderAgendaEvent={renderAgendaEvent}
          renderMoreContent={({ day, segments, close }) => (
            <div className="flex min-w-0 flex-col gap-1">
              <h2 className="px-2 py-1 font-medium">
                {day.toLocaleDateString(undefined, { dateStyle: 'full' })}
              </h2>
              {segments.map(({ occurrence }) => (
                <Button
                  key={occurrence.key}
                  type="button"
                  variant="ghost"
                  size="row"
                  className="w-full min-w-0 justify-start"
                  onClick={(event) => {
                    close()
                    openView(occurrence, event)
                  }}
                >
                  <span className="min-w-0 flex-1 truncate text-start">
                    {occurrence.event.title}
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {occurrence.allDay ? 'All day' : timeOf(occurrence.start)}
                  </span>
                </Button>
              ))}
            </div>
          )}
          renderNoEvents={renderNoEvents}
          className="min-w-0 flex-1"
        >
          {/* EventCalendarNav already carries px-2 py-2, so
                the row only needs matching right padding. Below sm the toolbar
                takes a full row of its own. */}
          <div className="flex flex-wrap items-center gap-x-2 pe-2">
            <EventCalendarNav className="w-full min-w-0 flex-nowrap sm:w-auto sm:flex-1" />
            <EventCalendarToolbar className="w-full sm:w-auto">
              {/* The rail owns the calendars list at lg+, so this menu is
                    only the narrow host for it. */}
              <div className="lg:hidden">
                <CalendarsMenu
                  calendars={calendar.calendars}
                  onToggle={calendar.setCalendarEnabled}
                />
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    disabled={calendar.loading}
                    onClick={calendar.reload}
                  >
                    <RefreshCwIcon className="size-4" aria-hidden="true" />
                    <span className="sr-only">Refresh</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Refresh</TooltipContent>
              </Tooltip>
              <Button
                className="flex-1 sm:flex-none"
                onClick={(event) =>
                  openCreate(quickAddStart(date), false, undefined, {
                    rect: event.currentTarget.getBoundingClientRect(),
                    element: event.currentTarget,
                  })
                }
              >
                <PlusIcon className="size-4" aria-hidden="true" />
                New event
              </Button>
            </EventCalendarToolbar>
          </div>
          {calendar.status.kind === 'error' && (
            <div
              role="alert"
              className="text-destructive flex items-center gap-2 border-t px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1">
                Couldn’t load your calendar: {calendar.status.message}
              </span>
              <Button type="button" variant="outline" size="sm" onClick={calendar.reload}>
                Retry
              </Button>
            </div>
          )}
          <EventCalendarContent />
        </EventCalendar>

        <EventCard
          state={card}
          anchor={cardAnchor}
          error={error}
          saving={saving}
          canCreateTask={canCreateTask}
          onOpenChange={closeCard}
          onDraftChange={updateDraft}
          onEdit={startEdit}
          onSave={() => void saveDraft()}
          onDelete={deleteDraft}
          onCreateTask={createTask}
          onOpenExternal={(url) => openExternal(url)}
        />
      </div>
    </TooltipProvider>
  )
}
