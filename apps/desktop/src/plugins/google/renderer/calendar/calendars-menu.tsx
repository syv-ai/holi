/**
 * Toolbar control that doubles as the color legend and the calendar picker,
 * from ReUI's `event-calendar-3` block. The trigger stacks a color dot per
 * calendar that is on; each row is a keyboard-operable checkbox item whose
 * visual is a checkbox in the calendar's colour.
 *
 * Switching one is the Agenda's setting (`google.setCalendar`), held in main
 * so the agent and vault apps honour it too. Yours are listed apart from the
 * ones you are subscribed to, as the Agenda's picker does.
 *
 * Dropped from the block: New, Edit and Delete calendar. Holi does not create
 * or delete Google calendars.
 */
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ChevronDownIcon } from 'lucide-react'
import { FALLBACK_COLOR, type CalendarChoice } from '../calendar-data'

export function CalendarsMenu({
  calendars,
  onToggle,
}: {
  calendars: CalendarChoice[]
  onToggle: (id: string, enabled: boolean) => void
}) {
  const visible = calendars.filter((calendar) => calendar.enabled)
  const mine = calendars.filter((calendar) => calendar.mine)
  const others = calendars.filter((calendar) => !calendar.mine)

  const row = (calendar: CalendarChoice) => {
    const color = calendar.color ?? FALLBACK_COLOR
    return (
      <DropdownMenuCheckboxItem
        key={calendar.id}
        checked={calendar.enabled}
        // Radix closes on select by default; keep it open for several ticks.
        onSelect={(event) => event.preventDefault()}
        onCheckedChange={(checked) => onToggle(calendar.id, checked)}
        className="min-w-0 gap-2 pr-2 [&_[data-slot=dropdown-menu-checkbox-item-indicator]]:hidden"
      >
        {/* Colored checkbox is the visual; the checkbox item owns the toggle
            and a11y, so this control is inert. The item's hover cascade
            recolors ALL descendants, so mirror that reach with
            **:text-white! to keep the tick white on hover. */}
        <Checkbox
          checked={calendar.enabled}
          aria-hidden="true"
          tabIndex={-1}
          className="pointer-events-none **:text-white!"
          style={calendar.enabled ? { backgroundColor: color, borderColor: color } : undefined}
        />
        <span className="min-w-0 flex-1 truncate">{calendar.name}</span>
      </DropdownMenuCheckboxItem>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Calendars" asChild>
        <Button type="button" variant="outline" disabled={calendars.length === 0}>
          {visible.length > 0 && (
            <span className="flex -space-x-1" aria-hidden="true">
              {visible.map((calendar) => (
                <span
                  key={calendar.id}
                  className="ring-background size-2.5 rounded-full ring-2"
                  style={{ backgroundColor: calendar.color ?? FALLBACK_COLOR }}
                />
              ))}
            </span>
          )}
          <ChevronDownIcon className="size-4 opacity-50" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Your calendars</DropdownMenuLabel>
          {mine.map(row)}
        </DropdownMenuGroup>
        {others.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {/* "Subscribed" is Google's word; these are off until asked for. */}
              <DropdownMenuLabel>Subscribed</DropdownMenuLabel>
              {others.map(row)}
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
