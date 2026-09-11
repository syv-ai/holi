/**
 * The recurrence rule, as one control.
 *
 * A builder rather than a text field, unlike `reminder` which is a stamp with a
 * parser. That is not inconsistency: a reminder IS a string with a grammar,
 * while a `Recurrence` is a **map** — `{frequency, interval, weekdays?,
 * endDate?}` — with no text form anywhere in `shared`. Inventing one here would
 * mean inventing a parser too, and a second way to say something the model
 * already says structurally.
 *
 * **One row, not four.** The four controls sit in a popover behind a trigger
 * that states the rule in words, because `recurrence` is a single frontmatter
 * key and a block that draws a row per key cannot let one of them occupy four.
 *
 * Roll-forward happens on complete (`nextDueCatchup`, in the router), so nothing
 * here computes a date; this only states the rule.
 */
import {
  type Recurrence,
  type RecurrenceFrequency,
  type RecurrenceWeekday,
  describeRecurrence,
} from '@holi/shared'
import {
  Button,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/primitives'
import { DateTimePicker } from './DateTimePicker'
import { FieldRow } from './FieldRow'
import { cn } from '@/lib/cn'

const WEEKDAYS: RecurrenceWeekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

export function RecurrenceField({
  value,
  onChange,
  'data-testid': testId,
}: {
  value: Recurrence | undefined
  onChange: (next: Recurrence | undefined) => void
  'data-testid'?: string
}): React.JSX.Element {
  /** Patch the rule as a whole — the frontmatter holds one map, so a partial
   *  write would drop the fields it did not mention. */
  const set = (patch: Partial<Recurrence> | null): void => {
    if (patch === null) return onChange(undefined)
    onChange({ frequency: 'daily', interval: 1, ...value, ...patch })
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          data-testid={testId}
          className={cn(
            // The field treatment every control in a row wears, so a picker, a
            // Select and this read as the same kind of thing.
            'h-8 w-full min-w-0 shrink justify-end rounded-md border border-input px-3',
            'text-xs font-normal hover:bg-transparent focus-visible:border-ring',
            value === undefined && 'text-muted-foreground',
          )}
        >
          <span className="truncate">
            {value === undefined ? 'never' : describeRecurrence(value)}
          </span>
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="flex w-64 flex-col gap-1 p-3">
        <FieldRow label="repeats">
          {/* 'never' is the sentinel for "no recurrence" (Radix forbids ''). */}
          <Select
            value={value?.frequency ?? 'never'}
            onValueChange={(v) =>
              v === 'never' ? set(null) : set({ frequency: v as RecurrenceFrequency })
            }
          >
            <SelectTrigger size="sm" className="w-28 justify-between" data-detail-recurrence>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="never">never</SelectItem>
              <SelectItem value="daily">daily</SelectItem>
              <SelectItem value="weekly">weekly</SelectItem>
              <SelectItem value="monthly">monthly</SelectItem>
              <SelectItem value="yearly">yearly</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>

        {value !== undefined && (
          <>
            <FieldRow label="every">
              <Input
                type="number"
                min={1}
                value={value.interval}
                aria-label="interval"
                data-detail-interval
                className="h-7 w-14 text-right text-xs"
                onChange={(e) => set({ interval: Math.max(1, Number(e.target.value) || 1) })}
              />
              <span className="shrink-0 text-xs text-muted-foreground">
                {{ daily: 'days', weekly: 'weeks', monthly: 'months', yearly: 'years' }[
                  value.frequency
                ]}
              </span>
            </FieldRow>

            {/* Weekdays are a weekly-only field in the model, and an empty list
                means "no weekday constraint" — `nextWeeklyWeekday` returns null
                on an empty set, which would silently stop the recurrence. So
                none-selected is stored as absent. */}
            {value.frequency === 'weekly' && (
              <FieldRow label="on">
                <span className="flex gap-0.5">
                  {WEEKDAYS.map((d) => {
                    const on = value.weekdays?.includes(d) ?? false
                    return (
                      <Button
                        key={d}
                        size="xs"
                        variant={on ? 'secondary' : 'ghost'}
                        data-detail-weekday={d}
                        className={cn('min-w-5 px-0 text-[10px]', !on && 'text-muted-foreground')}
                        onClick={() => {
                          const next = on
                            ? (value.weekdays ?? []).filter((w) => w !== d)
                            : [...(value.weekdays ?? []), d]
                          set({
                            weekdays: next.length
                              ? WEEKDAYS.filter((w) => next.includes(w))
                              : undefined,
                          })
                        }}
                      >
                        {d[0]}
                      </Button>
                    )
                  })}
                </span>
              </FieldRow>
            )}

            {/* No time row and no shortcuts: `until` is a boundary on the rule,
                not an appointment, and "in a week" is not a thing a repeat ends. */}
            <FieldRow label="until">
              <DateTimePicker
                value={value.endDate ?? null}
                placeholder="never ends"
                dateOnly
                data-testid="detail-recurrence-end"
                onChange={(next) => set({ endDate: next ?? undefined })}
              />
            </FieldRow>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
