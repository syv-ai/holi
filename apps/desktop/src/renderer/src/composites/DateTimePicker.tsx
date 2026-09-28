/**
 * A date, an optional time, and the shortcuts to both (D79): one control for
 * `due`, `reminder` and a recurrence rule's `until`.
 *
 * It knows nothing about tasks: a stamp goes in and out, and the preset rail is
 * computed by the caller. It holds no date arithmetic either: that lives in
 * `@holi/shared` (`dates.ts`). Beyond "what is today", a `new Date(...)` here
 * means a helper is missing there.
 */
import {
  ANCHOR_HOUR,
  gridFocusMove,
  monthGrid,
  parseStamp,
  stampDate,
  stampTime,
  withTime,
} from '@holi/shared'
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  Button,
  Icon,
  IconButton,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
} from '@/primitives'
import { useFieldControlId } from './FieldRow'
import { cn } from '@/lib/cn'
import type { DatePreset } from '@/lib/date-presets'

/** The selected day's treatment. */
const SELECTED_DAY =
  'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground'

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
const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

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

/** What the trigger says. A value that is not a stamp (a hand-written `1d`)
 *  comes back verbatim. */
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
  emptyText,
  variant = 'default',
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
  /**
   * What an empty field SHOWS, when that differs from what it is CALLED
   * (`placeholder` is both by default). In a labelled row the row already says
   * `due`, but the control still needs `due` as its accessible name.
   */
  emptyText?: string
  /** `field` in a labelled row that frames it (the frontmatter block); the
   *  default keeps an edge, as a form field does in a dialog or popover. */
  variant?: 'default' | 'field'
  'data-testid'?: string
}): React.JSX.Element {
  const id = useFieldControlId()
  const selected = value === null ? null : stampDate(value)
  const time = value === null ? null : stampTime(value)
  const today = todayLocal()

  // The visible month is state, not derived, or paging would snap back on any
  // re-render. Seeded when the popover opens (`startAt`), not at mount: the
  // picker outlives its value when another task is selected.
  const [view, setView] = useState(() => partsOf(selected ?? today))
  const grid = monthGrid(view.year, view.month)

  /**
   * The grid's roving focus: one cell is tabbable, the arrows move which. A
   * date, not an index, because a move may leave the month. `moved` makes sure
   * only a key pulls focus into the grid, not opening or typing a time.
   */
  const [focusDate, setFocusDate] = useState(selected ?? today)
  const moved = useRef(false)
  const gridRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!moved.current) return
    moved.current = false
    gridRef.current?.querySelector<HTMLElement>(`[data-date="${focusDate}"]`)?.focus()
  }, [focusDate])

  const onGridKeyDown = (e: React.KeyboardEvent) => {
    const from = (e.target as HTMLElement).dataset.date
    if (from === undefined) return
    const next = gridFocusMove(from, e.key)
    if (next === null) return
    // Only for keys the grid claims — Tab and Escape have to leave the popover.
    e.preventDefault()
    moved.current = true
    setFocusDate(next)
    const at = partsOf(next)
    if (at.year !== view.year || at.month !== view.month) setView(at)
  }

  // The tabbable cell must exist, or the grid drops out of the tab order:
  // paging can leave `focusDate` in another month.
  const inGrid = grid.flat().some((c) => c.date === focusDate)
  const tabDate = inGrid ? focusDate : (grid.flat().find((c) => c.inMonth)?.date ?? null)

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

  // Controlled: a preset is a complete answer and closes the popover; picking a
  // day leaves it open for a time.
  const [open, setOpen] = useState(false)

  /**
   * Opening starts a fresh navigation from the value. Within one session paging
   * is left alone; the next open follows whatever the value is by then.
   */
  const startAt = (next: boolean) => {
    if (next) {
      setView(partsOf(selected ?? today))
      setFocusDate(selected ?? today)
    }
    setOpen(next)
  }

  return (
    <Popover open={open} onOpenChange={startAt}>
      <Tooltip content={placeholder ?? 'pick a date'}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            variant={variant === 'field' ? 'field' : 'outline'}
            size="sm"
            data-testid={testId}
            // The visible text is the value, so name the field. The tooltip
            // cannot: Radix wires `content` as a description, not a name.
            aria-label={placeholder}
            className={cn(
              // `shrink`: the Button base is `shrink-0`, and a full-width
              // trigger in a label+control row would overhang it.
              variant === 'default' && 'w-full shrink justify-end text-xs font-normal',
              value === null && 'text-muted-foreground',
            )}
          >
            {/* The value truncates rather than pushing the icon out: a long
                stamp in a narrow panel is a layout problem, not a reason to
                lose the affordance that says this opens a calendar. */}
            <span className="truncate">{humanise(value) ?? emptyText ?? placeholder ?? ''}</span>
            <Icon icon={CalendarDays} size="sm" tone="muted" />
          </Button>
        </PopoverTrigger>
      </Tooltip>

      <PopoverContent align="end" className={cn('w-auto p-0', rail.length > 0 && 'flex')}>
        {rail.length > 0 && (
          <div className="flex w-51 shrink-0 flex-col gap-0.5 border-r border-divider p-2">
            {rail.map((p) => (
              <Button
                key={p.label}
                variant="ghost"
                size="sm"
                className="h-7 justify-between gap-3 px-2 text-xs font-normal whitespace-nowrap"
                onClick={() => {
                  onChange(p.value)
                  setOpen(false)
                }}
              >
                {p.label}
                {p.hint !== undefined && (
                  <span className="shrink-0 text-[10px] text-muted-foreground">{p.hint}</span>
                )}
              </Button>
            ))}
          </div>
        )}

        <div className="min-w-0">
          {/* No tooltips on the paging arrows: opening the popover focuses the
              first of them, and a tooltip opened by that focus would take the
              first Escape meant for the popover. */}
          <div className="flex items-center justify-between px-2 pt-2">
            <IconButton
              icon={ChevronLeft}
              label="previous month"
              tooltip={false}
              onClick={() => page(-1)}
            />
            <span className="text-xs font-medium">
              {MONTHS[view.month - 1]} {view.year}
            </span>
            <IconButton
              icon={ChevronRight}
              label="next month"
              tooltip={false}
              onClick={() => page(1)}
            />
          </div>

          <div className="grid grid-cols-7 gap-px p-2" ref={gridRef} onKeyDown={onGridKeyDown}>
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
                data-date={cell.date}
                tabIndex={cell.date === tabDate ? 0 : -1}
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
                    className="ml-auto h-7 w-auto px-2 text-xs"
                    onChange={(e) =>
                      selected !== null &&
                      e.target.value !== '' &&
                      onChange(withTime(selected, e.target.value))
                    }
                  />
                  <IconButton
                    icon={X}
                    label="remove the time"
                    onClick={() => selected !== null && onChange(selected)}
                  />
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
