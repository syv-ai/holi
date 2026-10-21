/**
 * Five-field cron expressions, read in the machine's own local time: the
 * clock a scheduled agent's person reads (docs/features/scheduled-agents.md).
 *
 * `minute hour day-of-month month day-of-week`, each a `*`, a number, a range
 * `a-b`, a step `*\/n` or `a-b/n`, or a comma list of those. Months and days
 * of the week also take their three-letter English names, and day-of-week 7
 * is Sunday like 0. The `@hourly`, `@daily`, `@weekly`, `@monthly` and
 * `@yearly` macros stand for their usual expansions.
 *
 * As in every cron, a day matches when **either** day field matches if both
 * are restricted, and when the restricted one matches otherwise.
 *
 * Pure and browser-safe: the times are `Date`s, read through their local
 * getters, so a test that builds its dates with the local constructor holds in
 * any time zone.
 */

export interface Cron {
  /** As written, trimmed. */
  source: string
  minutes: ReadonlySet<number>
  hours: ReadonlySet<number>
  days: ReadonlySet<number>
  months: ReadonlySet<number>
  /** 0 is Sunday; a written 7 is folded into 0. */
  weekdays: ReadonlySet<number>
  /** The day-of-month field was `*`. */
  anyDay: boolean
  /** The day-of-week field was `*`. */
  anyWeekday: boolean
}

export class CronError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CronError'
  }
}

const MACROS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
}

const MONTH_NAMES = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
]
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

interface FieldSpec {
  label: string
  min: number
  max: number
  names?: readonly string[]
  /** What the first name stands for: months count from 1, days from 0. */
  nameBase?: number
}

const FIELDS: readonly FieldSpec[] = [
  { label: 'minute', min: 0, max: 59 },
  { label: 'hour', min: 0, max: 23 },
  { label: 'day of month', min: 1, max: 31 },
  { label: 'month', min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  // 7 is accepted as Sunday and folded into 0 after parsing.
  { label: 'day of week', min: 0, max: 7, names: DAY_NAMES, nameBase: 0 },
]

function value(raw: string, spec: FieldSpec): number {
  const lower = raw.toLowerCase()
  const named = spec.names?.indexOf(lower) ?? -1
  if (named >= 0) return named + (spec.nameBase ?? 0)
  if (!/^\d+$/.test(raw)) throw new CronError(`${spec.label}: "${raw}" is not a number`)
  const n = Number(raw)
  if (n < spec.min || n > spec.max) {
    throw new CronError(`${spec.label}: ${n} is outside ${spec.min}-${spec.max}`)
  }
  return n
}

function field(raw: string, spec: FieldSpec): Set<number> {
  const out = new Set<number>()
  for (const part of raw.split(',')) {
    if (part === '') throw new CronError(`${spec.label}: an empty item in "${raw}"`)
    const [range, stepText, extra] = part.split('/')
    if (extra !== undefined) throw new CronError(`${spec.label}: "${part}" has two steps`)
    let step = 1
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) === 0) {
        throw new CronError(`${spec.label}: the step in "${part}" must be a positive number`)
      }
      step = Number(stepText)
    }
    let lo: number
    let hi: number
    if (range === '*') {
      lo = spec.min
      hi = spec.max
    } else if (range!.includes('-')) {
      const [a, b] = range!.split('-')
      lo = value(a ?? '', spec)
      hi = value(b ?? '', spec)
      if (lo > hi) throw new CronError(`${spec.label}: "${range}" runs backwards`)
    } else {
      lo = value(range!, spec)
      // `5/15` is "from 5, every 15", as most crons read it.
      hi = stepText === undefined ? lo : spec.max
    }
    for (let n = lo; n <= hi; n += step) out.add(n)
  }
  return out
}

/** Parse an expression, or throw a `CronError` that says which field is wrong. */
export function parseCron(expression: string): Cron {
  const source = expression.trim()
  const expanded = MACROS[source.toLowerCase()] ?? source
  const parts = expanded.split(/\s+/)
  if (parts.length !== 5) {
    throw new CronError(
      `a cron expression has five fields (minute hour day month weekday), not ${parts.length}`,
    )
  }
  const [minutes, hours, days, months, weekdays] = parts.map((p, i) => field(p, FIELDS[i]!))
  if (weekdays!.delete(7)) weekdays!.add(0)
  return {
    source,
    minutes: minutes!,
    hours: hours!,
    days: days!,
    months: months!,
    weekdays: weekdays!,
    anyDay: parts[2] === '*',
    anyWeekday: parts[4] === '*',
  }
}

function dayMatches(cron: Cron, d: Date): boolean {
  const byDate = cron.days.has(d.getDate())
  const byWeekday = cron.weekdays.has(d.getDay())
  if (cron.anyDay && cron.anyWeekday) return true
  if (cron.anyDay) return byWeekday
  if (cron.anyWeekday) return byDate
  return byDate || byWeekday
}

/** Enough steps to cross several years of month, day and hour skips: the
 *  rarest real expression, 29 February on a given weekday, recurs within 28. */
const MAX_STEPS = 200_000

/**
 * The first minute strictly after `after` that the expression names, or null
 * when it names none (`0 0 30 2 *`). Steps by month, then day, then hour, then
 * minute, through the local setters, so a daylight-saving jump is the
 * platform's to resolve rather than ours.
 */
export function nextCronTime(cron: Cron, after: Date): Date | null {
  const t = new Date(after.getTime())
  t.setSeconds(0, 0)
  t.setMinutes(t.getMinutes() + 1)
  for (let i = 0; i < MAX_STEPS; i++) {
    if (!cron.months.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1)
      t.setHours(0, 0, 0, 0)
      continue
    }
    if (!dayMatches(cron, t)) {
      t.setDate(t.getDate() + 1)
      t.setHours(0, 0, 0, 0)
      continue
    }
    if (!cron.hours.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!cron.minutes.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1, 0, 0)
      continue
    }
    return t
  }
  return null
}

/**
 * The shortest gap, in minutes, between two runs within one day, read from
 * the minute and hour fields. A cheap structural bound rather than a search:
 * it is what a "too often" rule needs to know.
 */
export function shortestGapMinutes(cron: Cron): number {
  const times: number[] = []
  for (const h of [...cron.hours].sort((a, b) => a - b)) {
    for (const m of [...cron.minutes].sort((a, b) => a - b)) times.push(h * 60 + m)
  }
  if (times.length < 2) return 24 * 60
  let gap = 24 * 60 - times[times.length - 1]! + times[0]!
  for (let i = 1; i < times.length; i++) gap = Math.min(gap, times[i]! - times[i - 1]!)
  return gap
}

const pad = (n: number): string => String(n).padStart(2, '0')
const WEEKDAY_WORDS = [
  'Sundays',
  'Mondays',
  'Tuesdays',
  'Wednesdays',
  'Thursdays',
  'Fridays',
  'Saturdays',
]

function sorted(set: ReadonlySet<number>): number[] {
  return [...set].sort((a, b) => a - b)
}

/** The step a set walks from its first member, when it is exactly one. */
function stepOf(set: ReadonlySet<number>, min: number, max: number): number | null {
  const all = sorted(set)
  if (all.length < 2 || all[0] !== min) return null
  const step = all[1]! - all[0]!
  for (let i = 1; i < all.length; i++) if (all[i]! - all[i - 1]! !== step) return null
  return all[all.length - 1]! + step > max ? step : null
}

function daysPhrase(cron: Cron): string | null {
  if (!cron.anyDay || cron.months.size !== 12) return null
  if (cron.anyWeekday) return 'Every day'
  const days = sorted(cron.weekdays)
  if (days.join() === '1,2,3,4,5') return 'Weekdays'
  if (days.join() === '0,6') return 'Weekends'
  return days.map((d) => WEEKDAY_WORDS[d]).join(', ')
}

/**
 * The expression in words, for the common shapes: every n minutes, hourly at
 * a minute, a time on some days. Anything else reads as itself, which is still
 * true and is what the file says.
 */
export function describeCron(cron: Cron): string {
  const days = daysPhrase(cron)
  const minuteStep = stepOf(cron.minutes, 0, 59)
  if (days === 'Every day' && cron.hours.size === 24 && minuteStep !== null) {
    return minuteStep === 1 ? 'Every minute' : `Every ${minuteStep} minutes`
  }
  if (days !== null && cron.minutes.size === 1) {
    const minute = sorted(cron.minutes)[0]!
    const hourStep = stepOf(cron.hours, 0, 23)
    const scope = days === 'Every day' ? '' : ` on ${days.toLowerCase()}`
    if (cron.hours.size === 24) return `Hourly at :${pad(minute)}${scope}`
    if (hourStep !== null) return `Every ${hourStep} hours at :${pad(minute)}${scope}`
    const times = sorted(cron.hours).map((h) => `${pad(h)}:${pad(minute)}`)
    if (times.length <= 4) return `${days} at ${times.join(', ')}`
  }
  if (days !== null && minuteStep !== null && cron.hours.size < 24) {
    const hours = sorted(cron.hours)
    const contiguous = hours.every((h, i) => i === 0 || h === hours[i - 1]! + 1)
    if (contiguous) {
      const every = minuteStep === 1 ? 'Every minute' : `Every ${minuteStep} minutes`
      const scope = days === 'Every day' ? '' : `, ${days.toLowerCase()}`
      return `${every}, ${pad(hours[0]!)}:00–${pad(hours[hours.length - 1]!)}:59${scope}`
    }
  }
  return cron.source
}
