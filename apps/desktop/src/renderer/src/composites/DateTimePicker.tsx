/**
 * A date, an optional time, and the shortcuts to both (D79).
 *
 * One control for every date a task carries — `due`, `reminder`, and the
 * recurrence rule's `until` — which is what makes them read as one system
 * rather than three fields that happen to hold dates.
 *
 * **It knows nothing about tasks.** A stamp goes in, a stamp comes out, and the
 * preset rail is a list of `{label, value}` the *caller* computed: "1 day
 * before" means nothing without a due date, and a composite that knew what a
 * due date was would not be a composite. That is also what lets the has-due and
 * no-due vocabularies live in the tasks feature, where `task.due` is in scope.
 *
 * **It holds no date arithmetic either.** `monthGrid` draws the month,
 * `withTime`/`stampTime`/`stampDate` make every edit, `parseStamp` reads the
 * value for the trigger — all from `@holi/shared`, all pure, all tested without
 * a DOM. If this file ever needs `new Date(...)` for anything but "what is
 * today", the helper it wants is missing from `dates.ts`.
 */
import { ANCHOR_HOUR, monthGrid, parseStamp, stampDate, stampTime, withTime } from '@holi/shared'
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useState } from 'react'
import { Button, Input, Popover, PopoverContent, PopoverTrigger, Tooltip } from '@/primitives'
import { cn } from '@/lib/cn'

/** The selected day's treatment. A const because the hover half repeats the
 *  base half, and the whole thing does not fit in 100 columns inline. */
const SELECTED_DAY =
  'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground'

/** A rail entry: what it says, the finished stamp it writes, and — because a
 *  shortcut should never be a guess — where that lands, shown beside it. */
export interface DatePreset {
  label: string
  value: string
  hint?: string
}

const WEEKDAY_HEADS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3))
const WEEKDAYS_LONG = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
]

/** Today, as `YYYY-MM-DD`, local. The only clock read in the file. */
function todayLocal(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** `2026-08-25` → `{year: 2026, month: 8, day: 25}`. The date half only. */
function partsOf(date: string): { year: number; month: number; day: number } {
  const [y, m, d] = date.split('-').map(Number)
  return { year: y!, month: m!, day: d! }
}

/**
 * What the trigger says.
 *
 * A value that is not a stamp comes back **verbatim** — a legacy `1d` survives
 * in a hand-written file, and the field has to show what is actually there
 * rather than a crash or a date it made up.
 */
function humanise(value: string | null): string | null {
  if (value === null) return null
  const parsed = parseStamp(value)
  if (parsed === null) return value
  const date = stampDate(value)!
  const { year, month, day } = partsOf(date)
  const time = stampTime(value)
  const day_ = `${day} ${MONTHS_SHORT[month - 1]} ${year}`
  return time === null ? day_ : `${day_}, ${time}`
}

/** The long label a day cell announces, e.g. "Wednesday, 26 August 2026". */
function dayLabel(date: string): string {
  const { year, month, day } = partsOf(date)
  const weekday = WEEKDAYS_LONG[(new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7]
  return `${weekday}, ${day} ${MONTHS[month - 1]} ${year}`
}

export function DateTimePicker({
  value,
  onChange,
  presets,
  dateOnly,
  placeholder,
  'data-testid': testId,
}: {
  /** A stamp, or null for empty. */
  value: string | null
  onChange: (next: string | null) => void
  /** Rail entries, in order. Absent or empty renders no rail. */
  presets?: DatePreset[]
  /** Hide the time row — `until` is a boundary on a rule, not an appointment. */
  dateOnly?: boolean
  placeholder?: string
  'data-testid'?: string
}): React.JSX.Element {
  const selected = value === null ? null : stampDate(value)
  const time = value === null ? null : stampTime(value)
  const today = todayLocal()

  // The visible month is state, seeded once from the value: derived-per-render
  // would snap back to the selection the moment anything else re-rendered, and
  // paging is the thing you do most in a calendar.
  const [view, setView] = useState(() => partsOf(selected ?? today))
  const grid = monthGrid(view.year, view.month)

  const page = (delta: number) => {
    const month = view.month + delta
    // `monthGrid` normalises 0 and 13 itself; mirror that here so the header
    // shows the month the grid is actually drawing.
    if (month < 1) setView({ ...view, year: view.year - 1, month: 12 })
    else if (month > 12) setView({ ...view, year: view.year + 1, month: 1 })
    else setView({ ...view, month })
  }

  /** Keep the value's own time (or timelessness) and move the day under it. */
  const pickDay = (date: string) => onChange(time === null ? date : withTime(date, time))

  const rail = presets ?? []

  return (
    <Popover>
      <Tooltip content={placeholder ?? 'pick a date'}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            data-testid={testId}
            // The visible text is the VALUE, so without this the field's
            // accessible name is "25 Aug 2026, 14:00" and nothing says which
            // field that is. The tooltip cannot do the job: Radix wires
            // `content` as a description, not as the name.
            aria-label={placeholder}
            className={cn(
              // The field treatment the rows beside it wear, so a picker and a
              // Select read as the same kind of control.
              'h-8 w-full justify-end gap-2 rounded-md border border-input px-3',
              'text-xs font-normal hover:bg-transparent focus-visible:border-ring',
              value === null && 'text-muted-foreground',
            )}
          >
            {humanise(value) ?? placeholder ?? ''}
            <CalendarDays className="size-3.5 shrink-0 opacity-60" />
          </Button>
        </PopoverTrigger>
      </Tooltip>

      <PopoverContent align="end" className={cn('w-auto p-0', rail.length > 0 && 'flex')}>
        {rail.length > 0 && (
          <div className="flex w-38 shrink-0 flex-col gap-0.5 border-r border-divider p-2">
            {rail.map((p) => (
              <Button
                key={p.label}
                variant="ghost"
                size="sm"
                className="h-7 justify-between gap-3 px-2 text-xs font-normal"
                onClick={() => onChange(p.value)}
              >
                {p.label}
                {p.hint !== undefined && (
                  <span className="text-[10px] text-muted-foreground">{p.hint}</span>
                )}
              </Button>
            ))}
          </div>
        )}

        <div className="min-w-0">
          <div className="flex items-center justify-between px-2 pt-2">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="previous month"
              onClick={() => page(-1)}
            >
              <ChevronLeft />
            </Button>
            <span className="text-xs font-medium">
              {MONTHS[view.month - 1]} {view.year}
            </span>
            <Button variant="ghost" size="icon-xs" aria-label="next month" onClick={() => page(1)}>
              <ChevronRight />
            </Button>
          </div>

          <div className="grid grid-cols-7 gap-px p-2">
            {WEEKDAY_HEADS.map((d, i) => (
              <span
                key={i}
                aria-hidden
                className="flex h-6 items-center justify-center text-[10px] text-muted-foreground"
              >
                {d}
              </span>
            ))}
            {grid.flat().map((cell) => (
              <Button
                key={cell.date}
                variant="ghost"
                size="xs"
                aria-label={dayLabel(cell.date)}
                aria-current={cell.date === today ? 'date' : undefined}
                onClick={() => pickDay(cell.date)}
                className={cn(
                  'h-7 w-7 justify-center rounded-md p-0 text-[11px] font-normal',
                  !cell.inMonth && 'text-muted-foreground/50',
                  cell.date === today && 'ring-1 ring-brand ring-inset',
                  cell.date === selected && SELECTED_DAY,
                )}
              >
                {Number(cell.date.slice(8))}
              </Button>
            ))}
          </div>

          {/* Where "optional" lives. No checkbox and no sentinel hour: a value
              either names a time or it does not, and the row shows whichever
              of those two things is true. */}
          {dateOnly !== true && (
            <div className="flex items-center gap-2 border-t border-divider px-3 py-2 text-xs">
              {time === null ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={selected === null}
                  className="h-7 px-2 text-xs font-normal text-brand"
                  onClick={() => selected !== null && onChange(withTime(selected, ANCHOR_TIME))}
                >
                  + add a time
                </Button>
              ) : (
                <>
                  <span className="text-muted-foreground">time</span>
                  <Input
                    type="time"
                    value={time}
                    aria-label="time"
                    className="ml-auto h-7 w-auto rounded-md border border-input px-2 text-xs"
                    onChange={(e) =>
                      selected !== null &&
                      e.target.value !== '' &&
                      onChange(withTime(selected, e.target.value))
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="remove the time"
                    onClick={() => selected !== null && onChange(selected)}
                  >
                    <X />
                  </Button>
                </>
              )}
              <Button
                variant="ghost"
                size="sm"
                disabled={value === null}
                className="ml-auto h-7 px-2 text-xs font-normal text-muted-foreground"
                onClick={() => onChange(null)}
              >
                clear
              </Button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** The hour `+ add a time` seeds, as `HH:MM` — the same one a timeless reminder
 *  fires at, so adding a time to one does not silently move it. */
const ANCHOR_TIME = `${String(ANCHOR_HOUR).padStart(2, '0')}:00`
