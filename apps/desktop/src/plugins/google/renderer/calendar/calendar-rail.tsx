/**
 * The calendar's left rail, from ReUI's `event-calendar-3` block: the
 * calendars picker in its header, a mini month calendar sharing the view's
 * date, and the selected day's events in clock order. Below `lg` the rail is
 * hidden and the grid's toolbar hosts the calendars menu instead.
 *
 * The day sheet follows the SELECTED DATE, so paging the grid re-reads the
 * rail. The mini calendar's dots describe the events the view has loaded,
 * which is the visible range: browsing it past that range shows no dots.
 *
 * Dropped from the block: the front-desk counters (arrivals, departures,
 * jobs) and the guests' portraits. A day says how many events it has and how
 * many invitations wait for an answer; a row's tile says meeting, call or
 * block.
 */
import { useMemo, useState, type CSSProperties } from 'react'
import { Badge } from '@/components/ui/badge'
import { getDayKey } from '@/components/ui/event-calendar/event-calendar-lib'
import { expandRecurrence } from '@/components/ui/event-calendar/event-calendar-recurrence'
import type { EventCalendarOccurrence } from '@/components/ui/event-calendar/event-calendar-types'
import { IconTile } from '@/components/ui/icon-tile'
import { cn } from '@/plugin-api'
import { addDays, startOfDay, startOfMonth, startOfWeek, subDays } from 'date-fns'
import { DayButton } from 'react-day-picker'
import { Button } from '@/components/ui/button'
import { Calendar, CalendarDayButton } from '@/components/ui/calendar'
import { Item, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { CalendarIcon, UsersIcon, VideoIcon } from 'lucide-react'
import type { CalendarChoice, GoogleCalendarItem, GoogleEventData } from '../calendar-data'
import { CalendarsMenu } from './calendars-menu'
import { WEEK_STARTS_ON, shortDay, timeOf } from './calendar-format'

// The event calendar resolves this same default when no timeZone prop is
// passed; matching it keeps the rail's dots aligned with the grid's days.
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

export function CalendarRail({
  date,
  onDateChange,
  events,
  calendars,
  loading,
  onToggleCalendar,
  onOpenOccurrence,
  className,
}: {
  date: Date
  onDateChange: (date: Date) => void
  events: GoogleCalendarItem[]
  calendars: CalendarChoice[]
  /** The first answer has not arrived: the day sheet shows skeleton rows. */
  loading: boolean
  onToggleCalendar: (id: string, enabled: boolean) => void
  onOpenOccurrence: (occurrence: EventCalendarOccurrence<GoogleEventData>) => void
  className?: string
}) {
  // The month the mini calendar paints. It is its own state so the user can
  // browse ahead without moving the grid, and it is pulled back during render
  // (never in an effect) whenever the view's date lands in another month.
  const dateMonth = startOfMonth(date)
  const [month, setMonth] = useState(dateMonth)
  const [syncedMonth, setSyncedMonth] = useState(dateMonth)
  if (dateMonth.getTime() !== syncedMonth.getTime()) {
    setSyncedMonth(dateMonth)
    setMonth(dateMonth)
  }

  // The 6-week grid actually on screen - dots must describe the month the user
  // is looking at, not the month the view's date happens to be in.
  const monthRange = useMemo(() => {
    const start = startOfWeek(month, { weekStartsOn: WEEK_STARTS_ON })
    return { start, end: addDays(start, 42) }
  }, [month])

  // Days carrying at least one event; a multi-day span marks each of its days.
  const busyDays = useMemo(() => {
    const set = new Set<string>()
    for (const event of events) {
      for (const occurrence of expandRecurrence(event, monthRange, {
        timeZone: TIME_ZONE,
      })) {
        // All-day ends are exclusive, so step back for the inclusive last day.
        const last = occurrence.allDay ? subDays(occurrence.end, 1) : occurrence.end
        const lastDay = startOfDay(last < occurrence.start ? occurrence.start : last)
        for (
          let cursor = startOfDay(occurrence.start);
          cursor <= lastDay;
          cursor = addDays(cursor, 1)
        ) {
          set.add(getDayKey(cursor, TIME_ZONE))
        }
      }
    }
    return set
  }, [events, monthRange])

  // The selected day's events, in clock order: everything that touches it.
  const daySheet = useMemo(() => {
    const from = startOfDay(date)
    const rows = events
      .flatMap((event) =>
        expandRecurrence(event, { start: from, end: addDays(from, 1) }, { timeZone: TIME_ZONE }),
      )
      .sort((a, b) => a.start.getTime() - b.start.getTime())
    return {
      rows,
      toAnswer: rows.filter((o) => o.event.data?.myResponse === 'needsAction').length,
    }
  }, [events, date])

  return (
    <aside className={className}>
      {/* The calendars picker lives in the rail header so the day sheet below
          keeps the vertical room. Same component the toolbar hosts below lg,
          so there is one calendars menu in the view, not two. */}
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">Calendars</h2>
        <CalendarsMenu calendars={calendars} onToggle={onToggleCalendar} />
      </div>
      {/* The month picker is fixed chrome: it drives the view's date, so it
          must stay reachable while the day sheet beneath it scrolls. */}
      <div className="shrink-0 px-3 pt-2 pb-1">
        {/* Paging it only browses (the grid stays put); selecting a day is the
            one write to the view's date. Never key this on the month -
            remounting DayPicker drops keyboard focus. */}
        <Calendar
          mode="single"
          required
          selected={date}
          month={month}
          onMonthChange={setMonth}
          onSelect={(next) => next && onDateChange(next)}
          weekStartsOn={WEEK_STARTS_ON}
          buttonVariant="ghost"
          className="w-full bg-transparent"
          components={{
            DayButton: ({
              day,
              modifiers,
              children,
              ...props
            }: React.ComponentProps<typeof DayButton>) => {
              const busy = !modifiers.outside && busyDays.has(getDayKey(day.date, TIME_ZONE))
              return (
                <CalendarDayButton day={day} modifiers={modifiers} {...props}>
                  {children}
                  {/* Reserve the dot slot on every day so numbers stay aligned;
                      color it only when the day carries an event. */}
                  <span
                    aria-hidden="true"
                    className={cn(
                      'size-1 rounded-full',
                      busy
                        ? 'bg-primary in-data-[selected-single=true]:bg-primary-foreground'
                        : 'bg-transparent',
                    )}
                  />
                </CalendarDayButton>
              )
            },
          }}
        />
      </div>

      <Separator />

      {/* Only the day sheet scrolls. */}
      <ScrollArea className="min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]>div]:block!">
        <div className="flex flex-col gap-4 px-3 pt-3 pb-3">
          <section className="flex flex-col gap-0.5">
            {/* The day header is a SELECTION read-out, not an action, so it
                stays a quiet surface (bg-accent plus the outline's edge). */}
            <Item size="xs" variant="outline" className="bg-accent mb-1">
              <ItemContent>
                <ItemTitle>{shortDay(date)}</ItemTitle>
                <ItemDescription className="flex items-center tabular-nums">
                  {loading ? (
                    <Skeleton className="h-3 w-24" />
                  ) : (
                    <>
                      <span>
                        {daySheet.rows.length} {daySheet.rows.length === 1 ? 'event' : 'events'}
                      </span>
                      {daySheet.toAnswer > 0 && (
                        <>
                          <Dot />
                          <span>{daySheet.toAnswer} to answer</span>
                        </>
                      )}
                    </>
                  )}
                </ItemDescription>
              </ItemContent>
            </Item>
            {loading ? (
              <DaySheetSkeleton />
            ) : (
              <DaySheetRows occurrences={daySheet.rows} onOpen={onOpenOccurrence} />
            )}
          </section>
        </div>
      </ScrollArea>
    </aside>
  )
}

/**
 * ReUI inline dot separator between two rendered segments. Tinted from
 * currentColor: every parent that renders one is already muted.
 */
function Dot() {
  return <span aria-hidden="true" className="size-1 shrink-0 rounded-full bg-current/40" />
}

function DaySheetSkeleton() {
  return (
    <div aria-label="Loading the day" className="flex flex-col gap-2 py-1.5">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex items-center gap-2.5">
          <Skeleton className="size-6 rounded-full" />
          <div className="flex flex-1 flex-col gap-1">
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  )
}

/** A call, a meeting, or a block of the person's own time. */
function tileIcon(data: GoogleEventData | undefined) {
  if (data?.conferenceUrl) return <VideoIcon aria-hidden="true" />
  if ((data?.attendeeCount ?? 0) > 1) return <UsersIcon aria-hidden="true" />
  return <CalendarIcon aria-hidden="true" />
}

/**
 * The selected day's events, in clock order. Badges render only for
 * EXCEPTIONS: an invitation still to answer, or a maybe. An accepted meeting
 * is the happy default and chipping it would spend the rail's colour on
 * "nothing to see here".
 */
function DaySheetRows({
  occurrences,
  onOpen,
}: {
  occurrences: EventCalendarOccurrence<GoogleEventData>[]
  onOpen: (occurrence: EventCalendarOccurrence<GoogleEventData>) => void
}) {
  if (occurrences.length === 0) {
    return <p className="text-muted-foreground px-2 py-4 text-xs">Nothing on this day.</p>
  }
  return (
    <>
      {occurrences.map((occurrence) => {
        const data = occurrence.event.data
        return (
          <Button
            key={occurrence.key}
            type="button"
            variant="ghost"
            size="row"
            onClick={() => onOpen(occurrence)}
            className="w-full"
          >
            <IconTile variant="outline" size="xs" radius="full">
              {tileIcon(data)}
            </IconTile>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span
                className={cn(
                  'min-w-0 truncate text-sm font-medium',
                  // Free time and someone else's event read quieter.
                  (data?.busy === false || data?.mine === false) && 'text-muted-foreground',
                )}
              >
                {occurrence.event.title}
              </span>
              <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
                <span
                  aria-hidden="true"
                  className="size-1.5 shrink-0 rounded-full bg-(color:--swatch)"
                  style={{ '--swatch': occurrence.event.color } as CSSProperties}
                />
                <span className="shrink-0 tabular-nums">
                  {occurrence.allDay ? 'All day' : timeOf(occurrence.start)}
                </span>
                {data?.location && (
                  <>
                    <Dot />
                    <span className="truncate">{data.location}</span>
                  </>
                )}
              </span>
            </span>
            {data?.myResponse === 'needsAction' && (
              <Badge variant="warning-light" className="shrink-0">
                Invited
              </Badge>
            )}
            {data?.myResponse === 'tentative' && (
              <Badge variant="info-light" className="shrink-0">
                Maybe
              </Badge>
            )}
          </Button>
        )
      })}
    </>
  )
}
