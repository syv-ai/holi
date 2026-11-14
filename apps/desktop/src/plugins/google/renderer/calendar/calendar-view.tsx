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
import {
  EVENT_CALENDAR_FADE_TRUNCATE,
  EventCalendarEvent,
} from '@/components/ui/event-calendar/event-calendar-event'
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
import { TooltipProvider } from '@/components/ui/tooltip'
import { ScrollArea } from '@/components/ui/scroll-area'
import { IconButton } from '@/composites/icon-button'
import { toast } from 'sonner'
import {
  activeRemoteAtom,
  cn,
  openDocumentAtom,
  openSettingsSectionAtom,
  useHasCapability,
  openExternal,
} from '@/plugin-api'
import { localDate } from '@holi/shared'
import { addMinutes, setHours, startOfDay, subDays } from 'date-fns'
import {
  CalendarDaysIcon,
  MapPinIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
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

import { CLOCK_FORMATS, ISO_WEEK_LOCALE, useTimeFormat, useWeekNumbers } from './calendar-settings'
import { EventCard, type EventCardAnchor, type EventDraft, type EventCardState } from './event-card'
import { useWheelSwipe } from './use-wheel-swipe'

type Occurrence = EventCalendarOccurrence<GoogleEventData>

/** Swipe paging, which needs the calendar's context: nothing to draw. */
function WheelSwipe(): null {
  useWheelSwipe()
  return null
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

export function CalendarView({ visible = true }: { visible?: boolean }): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const { account, currentSub } = useGoogleAccount()
  const accountIdentity = account ? `${account.email}:${currentSub ?? ''}` : null
  const calendar = useGoogleCalendar(remote, accountIdentity)
  useEffect(() => {
    const nextIdentity = `${remote ?? ''}:${accountIdentity ?? ''}`
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
  }, [remote, accountIdentity])
  const openSettings = useSetAtom(openSettingsSectionAtom)
  const openNote = useSetAtom(openDocumentAtom)
  const canCreateTask = useHasCapability(TASKS_CREATE) && remote !== null
  const clock = useTimeFormat()
  const weekNumbers = useWeekNumbers()
  const i18n = useMemo(() => ({ formats: CLOCK_FORMATS[clock] }), [clock])

  const [card, setCard] = useState<EventCardState | null>(null)
  const cardDraft = useRef<EventDraft | null>(null)
  const [cardAnchor, setCardAnchor] = useState<EventCardAnchor | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const cardIdentity = useRef(0)
  const pending = useRef(false)
  const contextIdentity = useRef(`${remote ?? ''}:${accountIdentity ?? ''}`)
  const newEventTrigger = useRef<HTMLButtonElement>(null)
  // The visible date, shared by the rail's mini calendar and the grid. One
  // source of truth: the mini calendar and grid nav both write it, both read it.
  const [date, setDate] = useState<Date>(() => new Date())
  const [railCollapsed, setRailCollapsed] = useState(false)

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
    (update: EventCalendarProposedUpdate<GoogleEventData>) =>
      !pending.current && update.event.data?.editable === true,
    [],
  )

  /** A drag or resize: painted at once, then sent; a refusal puts it back. */
  const handleEventUpdate = useCallback((update: EventCalendarProposedUpdate<GoogleEventData>) => {
    if (pending.current) return false
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
      setCardAnchor(anchor ? { ...anchor, fallback: newEventTrigger.current } : null)
      setError(null)
      const startDay = localDate(start)
      // Slot ends are exclusive; store the inclusive last day so multi-day
      // drag-creates keep their span.
      const lastDay = end && end > start ? localDate(allDay ? subDays(end, 1) : end) : startDay
      const draft: EventDraft = {
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
      }
      cardDraft.current = draft
      setCard({
        mode: 'create',
        identity: cardIdentity.current,
        draft,
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
      setCardAnchor({ rect, element, fallback: newEventTrigger.current })
      setError(null)
      const draft = draftFromOccurrence(occurrence)
      cardDraft.current = draft
      setCard({
        mode: 'view',
        identity: cardIdentity.current,
        draft,
      })
    },
    [],
  )

  const updateDraft = useCallback((draft: EventDraft) => {
    cardDraft.current = draft
  }, [])

  const startEdit = useCallback(() => {
    if (pending.current) return
    setError(null)
    setCard((prev) => (prev ? { ...prev, mode: 'edit', draft: prev.draft } : prev))
  }, [])

  const closeCard = useCallback((open: boolean) => {
    if (!open && !pending.current) {
      cardIdentity.current += 1
      setCard(null)
      setCardAnchor(null)
      setError(null)
    }
  }, [])

  const saveDraft = async (draft: EventDraft): Promise<boolean> => {
    if (!card || pending.current) return false
    const identity = cardIdentity.current
    const title = draft.title.trim()
    if (title === '') {
      setError('Give it a title.')
      return false
    }
    const start = draft.allDay ? toDate(draft.date, '00:00') : toDate(draft.date, draft.start)
    const end = draft.allDay ? midnightAfter(draft.dateEnd) : toDate(draft.dateEnd, draft.end)
    if (end <= start) {
      setError('It has to end after it starts.')
      return false
    }
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
        return true
      }
      return false
    } catch (err) {
      if (identity === cardIdentity.current) setError(messageOf(err, 'Could not save the event.'))
      return false
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
                {timeOf(occurrence.start, clock)}
              </span>
            ) : (
              <span
                className={cn(
                  'text-muted-foreground hidden @[8rem]:inline',
                  stacked ? EVENT_CALENDAR_FADE_TRUNCATE : 'truncate',
                )}
              >
                {timeOf(occurrence.start, clock)} - {timeOf(occurrence.end, clock)}
              </span>
            ))}
        </>
      )
    },
    [clock],
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
              : `${timeOf(occurrence.start, clock)} - ${timeOf(occurrence.end, clock)}`}
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
    [clock],
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
      <div className="@container/calendar-host flex h-full w-full min-w-0 flex-row overflow-hidden">
        <CalendarRail
          className={cn(
            'w-72 shrink-0 flex-col border-e',
            railCollapsed ? 'hidden' : 'hidden @min-[64rem]/calendar-host:flex',
          )}
          date={date}
          onDateChange={setDate}
          events={items}
          calendars={calendar.calendars}
          loading={firstLoad}
          displayed={visible}
          onToggleCalendar={calendar.setCalendarEnabled}
          onOpenOccurrence={openView}
        />
        <EventCalendar
          visible={visible}
          events={items}
          date={date}
          onDateChange={setDate}
          defaultView="week"
          views={['day', 'week', 'month', 'agenda']}
          weekStartsOn={WEEK_STARTS_ON}
          locale={ISO_WEEK_LOCALE}
          i18n={i18n}
          showWeekNumbers={weekNumbers}
          loading={calendar.loading}
          navButtonSize="default"
          nowIndicator={visible}
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
              rect:
                event.clientX !== 0 || event.clientY !== 0
                  ? new DOMRect(event.clientX, event.clientY, 1, 1)
                  : event.currentTarget.getBoundingClientRect(),
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
              <ScrollArea className="-me-2 min-h-0 **:data-[slot=scroll-area-viewport]:max-h-(--ec-more-max-height,16rem)">
                <div className="flex flex-col gap-1 py-1 ps-1 pe-4">
                  {segments.map((segment) => (
                    <EventCalendarEvent
                      key={segment.occurrence.key}
                      segment={segment}
                      className="w-full min-w-0 justify-start"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation()
                        close({ restoreFocus: false })
                        openView(segment.occurrence, event)
                      }}
                    />
                  ))}
                </div>
              </ScrollArea>
            </div>
          )}
          renderNoEvents={renderNoEvents}
          className="@container/calendar min-w-0 flex-1"
        >
          {/* EventCalendarNav already carries px-2 py-2, so
                the row only needs matching right padding. Below 48rem of calendar
                width, the toolbar takes a full row of its own. */}
          <div className="flex flex-wrap items-center gap-x-2 pe-2">
            <EventCalendarNav className="w-full min-w-0 flex-nowrap @min-[48rem]/calendar:w-auto @min-[48rem]/calendar:flex-1" />
            <EventCalendarToolbar className="w-full @min-[48rem]/calendar:w-auto">
              {/* The rail owns the calendars list while open in a wide pane. */}
              <div className={railCollapsed ? undefined : '@min-[64rem]/calendar-host:hidden'}>
                <CalendarsMenu
                  calendars={calendar.calendars}
                  onToggle={calendar.setCalendarEnabled}
                  displayed={visible}
                />
              </div>
              <IconButton
                className="hidden @min-[64rem]/calendar-host:inline-flex"
                label={railCollapsed ? 'Show calendar rail' : 'Hide calendar rail'}
                aria-pressed={!railCollapsed}
                onClick={() => setRailCollapsed((collapsed) => !collapsed)}
                size="icon"
              >
                {railCollapsed ? (
                  <PanelLeftOpenIcon className="size-4" aria-hidden="true" />
                ) : (
                  <PanelLeftCloseIcon className="size-4" aria-hidden="true" />
                )}
              </IconButton>
              <IconButton
                label="Refresh"
                size="icon"
                disabled={calendar.loading}
                onClick={calendar.reload}
              >
                <RefreshCwIcon className="size-4" aria-hidden="true" />
              </IconButton>
              <Button
                ref={newEventTrigger}
                className="flex-1 @min-[48rem]/calendar:flex-none"
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
          <WheelSwipe />
          <EventCalendarContent />
        </EventCalendar>

        <EventCard
          state={card === null ? null : { ...card, draft: cardDraft.current ?? card.draft }}
          anchor={visible ? cardAnchor : null}
          error={error}
          saving={saving}
          canCreateTask={canCreateTask}
          onOpenChange={closeCard}
          onEdit={startEdit}
          onSave={saveDraft}
          onDraftChange={updateDraft}
          onDelete={deleteDraft}
          onCreateTask={createTask}
          onOpenExternal={(url) => openExternal(url)}
        />
      </div>
    </TooltipProvider>
  )
}
