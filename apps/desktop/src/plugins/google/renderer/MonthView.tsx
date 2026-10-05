/**
 * The agenda as a month: six weeks of day cells, Monday first, with the week
 * numbers down the left and an event drawn on each day it covers. A timed
 * event is a colour bar and its title; an all-day one is a tinted pill. A day
 * with more than fits shows two and "+N more". Pressing a day's empty space
 * starts an event on it, pressing an event opens it.
 *
 * It draws what it is given and owns no data: the agenda fetches, this lays
 * out.
 */
import { useMemo } from 'react'
import { Button } from '@/primitives'
import { cn } from '@/plugin-api'
import { groupByDay, isoWeek, localDay, weeksOf } from './month-days'

/** What the grid needs of an event; the agenda's own is a superset. */
export interface GridEvent {
  id: string
  calendarId: string
  title: string
  start: string
  end: string
  allDay: boolean
  color: string | null
  busy: boolean
  mine: boolean
}

/** Chips a cell shows before it says "+N more". */
const MAX_CHIPS = 3

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

const timeOf = (iso: string): string =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/** `#rrggbb` with an alpha, for the tint behind an all-day pill; null for any
 *  colour that is not a plain hex, which falls back to the muted ground. */
function tint(color: string | null): string | undefined {
  return color !== null && /^#[0-9a-f]{6}$/i.test(color) ? `${color}33` : undefined
}

export function MonthView({
  year,
  month,
  events,
  onPickDay,
  onPickEvent,
  onMore,
}: {
  year: number
  /** 1-12. */
  month: number
  events: readonly GridEvent[]
  onPickDay: (day: string) => void
  onPickEvent: (event: GridEvent) => void
  /** "+N more" on a day. */
  onMore: (day: string) => void
}): React.JSX.Element {
  const weeks = useMemo(() => weeksOf(year, month), [year, month])
  const byDay = useMemo(() => groupByDay(events), [events])
  const today = localDay(new Date())
  const now = Date.now()

  return (
    <div role="grid" aria-label="Month" className="flex h-full min-h-0 flex-col">
      <div
        role="row"
        className="grid shrink-0 grid-cols-[2rem_repeat(7,minmax(0,1fr))] border-b border-divider"
      >
        <span />
        {WEEKDAYS.map((name) => (
          <span
            key={name}
            role="columnheader"
            className="px-2 py-1.5 text-right text-xs text-muted-foreground"
          >
            {name}
          </span>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-rows-6">
        {weeks.map((week) => (
          <div
            key={week[0]!.date}
            role="row"
            className="grid min-h-0 grid-cols-[2rem_repeat(7,minmax(0,1fr))] border-b border-divider last:border-b-0"
          >
            <span className="px-1 pt-1.5 text-[11px] text-muted-foreground/70 tabular-nums">
              {isoWeek(week[0]!.date)}
            </span>
            {week.map(({ date, inMonth }, column) => {
              const list = byDay.get(date) ?? []
              const shown = list.length > MAX_CHIPS ? MAX_CHIPS - 1 : list.length
              const day = Number(date.slice(8))
              const isToday = date === today
              const weekend = column >= 5
              return (
                <div
                  key={date}
                  role="gridcell"
                  tabIndex={0}
                  aria-label={`${date}${list.length > 0 ? `, ${list.length} events` : ''}`}
                  data-day={date}
                  data-today={isToday ? '' : undefined}
                  onClick={() => onPickDay(date)}
                  onKeyDown={(event) => {
                    if (
                      event.target === event.currentTarget &&
                      (event.key === 'Enter' || event.key === ' ')
                    ) {
                      event.preventDefault()
                      onPickDay(date)
                    }
                  }}
                  className={cn(
                    'motion-respond flex min-h-0 min-w-0 cursor-default flex-col gap-0.5 overflow-hidden border-l border-divider px-1 pb-1 outline-none',
                    'hover:bg-secondary/40 focus-visible:bg-secondary/60',
                    weekend && 'bg-muted/40',
                  )}
                >
                  <span className="flex justify-end pt-1">
                    <span
                      className={cn(
                        'inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-sm tabular-nums',
                        isToday
                          ? 'bg-destructive font-medium text-white'
                          : inMonth
                            ? 'text-foreground'
                            : 'text-muted-foreground/60',
                      )}
                    >
                      {day === 1 && !isToday
                        ? `${MONTHS_SHORT[Number(date.slice(5, 7)) - 1]} ${day}`
                        : day}
                    </span>
                  </span>
                  {list.slice(0, shown).map((event) => {
                    const past = !event.allDay && Date.parse(event.end) < now
                    return (
                      <Button
                        key={`${event.calendarId}:${event.id}:${date}`}
                        variant="ghost"
                        size="xs"
                        aria-label={`${event.title}, ${event.allDay ? 'all day' : timeOf(event.start)}`}
                        data-event={event.id}
                        className={cn(
                          'h-5 w-full min-w-0 justify-start gap-1.5 rounded-md p-0 px-1 text-left text-xs font-normal',
                          (past || !event.busy) && 'opacity-60',
                          !event.mine && 'text-muted-foreground',
                        )}
                        style={event.allDay ? { background: tint(event.color) } : undefined}
                        onClick={(click) => {
                          click.stopPropagation()
                          onPickEvent(event)
                        }}
                      >
                        {!event.allDay && (
                          <span
                            aria-hidden
                            className={cn(
                              'h-3.5 w-1 shrink-0 rounded-full',
                              event.color === null && 'bg-muted-foreground',
                            )}
                            style={event.color === null ? undefined : { background: event.color }}
                          />
                        )}
                        <span className="truncate">{event.title}</span>
                      </Button>
                    )
                  })}
                  {list.length > shown && (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="h-5 w-full justify-start rounded-md p-0 px-1 text-xs font-normal text-muted-foreground"
                      onClick={(click) => {
                        click.stopPropagation()
                        onMore(date)
                      }}
                    >
                      +{list.length - shown} more
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
