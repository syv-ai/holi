/**
 * The event form's fields, from ReUI's `event-calendar-3` block: a calendar
 * date picker, a 15-minute time select and a calendar's colour dot. Times and
 * dates read in the person's language, as the rest of the Agenda does.
 *
 * Dropped from the block: the guests combobox and the calendar select. Holi
 * never invites anyone (an invitation emails them, `docs/features/google.md`)
 * and writes only to the primary calendar.
 */
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { localDate } from '@holi/shared'
import { WEEK_STARTS_ON, clockLabel } from './calendar-format'

const pad = (n: number): string => String(n).padStart(2, '0')

// 15-minute time steps shared by the start/end selects.
const TIME_OPTIONS = Array.from({ length: 96 }, (_, i) => {
  const value = `${pad(Math.floor(i / 4))}:${pad((i % 4) * 15)}`
  return { value, label: clockLabel(value) }
})

/** A calendar's color swatch (matches the round event-chip dots). The colour
 *  is Google's, not a token: there is no token for "Jane's calendar". */
export function CalendarDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="size-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
    />
  )
}

/** Start/end 15-minute time picker (96 options), plus an off-grid value an
 *  event already has. */
export function TimeSelect({
  id,
  value,
  onChange,
  disabled,
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  const options = TIME_OPTIONS.some((option) => option.value === value)
    ? TIME_OPTIONS
    : [...TIME_OPTIONS, { value, label: clockLabel(value) }].sort((a, b) =>
        a.value.localeCompare(b.value),
      )
  return (
    <Select
      value={value}
      onValueChange={(next: string) => next && onChange(next)}
      disabled={disabled}
    >
      <SelectTrigger id={id} className="w-full">
        <SelectValue>{value ? clockLabel(value) : null}</SelectValue>
      </SelectTrigger>
      <SelectContent position="popper">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Calendar-date picker; value is a "yyyy-MM-dd" string. */
export function DateField({
  id,
  value,
  onSelect,
  disabled,
}: {
  id?: string
  value: string
  onSelect: (iso: string) => void
  disabled?: boolean
}) {
  const selected = new Date(`${value}T00:00:00`)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          className="w-full justify-start font-normal"
        >
          {selected.toLocaleDateString(undefined, { dateStyle: 'medium' })}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0!">
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected}
          weekStartsOn={WEEK_STARTS_ON}
          onSelect={(date: Date | undefined) => date && onSelect(localDate(date))}
        />
      </PopoverContent>
    </Popover>
  )
}
