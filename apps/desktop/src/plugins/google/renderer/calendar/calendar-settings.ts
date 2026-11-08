/**
 * The calendar view's two display settings, core's `timeFormat` and
 * `weekNumbers` (`VAULT_SETTINGS`, this machine's by default): which clock it
 * writes times on and whether its month shows week numbers.
 */
import type { Locale } from 'date-fns'
import { enUS } from 'date-fns/locale/en-US'
import type { TimeFormat } from '@holi/shared'
import { useAppSetting } from '@/plugin-api'
import { WEEK_STARTS_ON } from './calendar-format'

export const useTimeFormat = (): TimeFormat => useAppSetting('timeFormat')

export const useWeekNumbers = (): boolean => useAppSetting('weekNumbers')

/**
 * The event calendar's date-fns patterns for each clock. The calendar draws
 * the gutter and its own time labels (drag previews, chip names) from these;
 * the chips, rail and sheet go through `timeOf`.
 */
export const CLOCK_FORMATS = {
  '24h': { timeGutter: 'HH:mm', timeGutterMinute: 'HH:mm', eventTime: 'HH:mm' },
  '12h': { timeGutter: 'h a', timeGutterMinute: 'h:mm a', eventTime: 'h:mm a' },
} as const satisfies Record<TimeFormat, Record<string, string>>

/**
 * English, with ISO weeks: Monday first and week 1 the one holding the
 * year's first Thursday, so the month's week numbers match the Agenda's
 * (`isoWeek`). The calendar numbers weeks through its locale, and date-fns'
 * default numbers them the US way.
 */
export const ISO_WEEK_LOCALE: Locale = {
  ...enUS,
  options: { ...enUS.options, weekStartsOn: WEEK_STARTS_ON, firstWeekContainsDate: 4 },
}
