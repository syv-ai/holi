/**
 * The calendar view's two display settings, the plugin's own `timeFormat`
 * and `weekNumbers` (`GOOGLE_INFO.settings`, committed in `plugins.yaml` and
 * overridable in `plugins.local.yaml`): which clock it writes times on and
 * whether its month shows week numbers.
 */
import type { Locale } from 'date-fns'
import { enUS } from 'date-fns/locale/en-US'
import { trpc, usePluginSetting } from '@/plugin-api'
import { GOOGLE_INFO } from '../../info'
import { WEEK_STARTS_ON, type TimeFormat } from './calendar-format'

export const useTimeFormat = (): TimeFormat =>
  usePluginSetting(GOOGLE_INFO, 'timeFormat') === '12h' ? '12h' : '24h'

export const useWeekNumbers = (): boolean => usePluginSetting(GOOGLE_INFO, 'weekNumbers') !== false

/** Write one of the two into the file it names (`PluginSetting.target`), through
 *  core's validated settings write. The view follows when the file changes. */
export async function writeCalendarSetting(
  remote: string,
  key: 'timeFormat' | 'weekNumbers',
  value: TimeFormat | boolean,
): Promise<string[]> {
  const target = GOOGLE_INFO.settings?.find((s) => s.key === key)?.target ?? 'committed'
  const patch = JSON.stringify({ [GOOGLE_INFO.id]: { [key]: value } })
  const result = await trpc.settings.write.mutate({
    remote,
    ...(target === 'committed' ? { committedJson: patch } : { localJson: patch }),
  })
  return result.warnings
}

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
