import { TZDate } from '@date-fns/tz'
import ICAL from 'ical.js'

// Both incoming parts and Sent evidence are untrusted. Bound work before calling
// ical.js, including folding, nested components, and the separate timezone work.
const MAX_BYTES = 256 * 1024
const MAX_LINES = 4096
const MAX_LINE_BYTES = 8192
const MAX_COMPONENTS = 128
const MAX_DEPTH = 4
const MAX_ZONES = 8
const MAX_OBSERVANCES = 24
const MAX_ZONE_YEARS = 12
const MAX_TRANSITION_WORK = 1024

export class CalendarPartError extends Error {}

export function malformed(): never {
  throw new CalendarPartError('Calendar invitation is malformed or unsupported')
}

function tooLarge(): never {
  throw new CalendarPartError('Calendar invitation exceeds its size or complexity limits')
}

function unsupportedZone(): never {
  throw new CalendarPartError('Calendar invitation uses an unsupported time zone definition')
}

const DATE = /^([1-9]\d{3})(\d{2})(\d{2})$/
const DATE_TIME = /^([1-9]\d{3})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/
const DAY_MS = 86_400_000
const DURATION = /^\+?P(?:(\d+)W|(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?)$/

export type ResolveTime = (time: ICAL.Time, property: ICAL.Property | null) => string

// Validate wire values before ical.js can coerce a partial integer or normalize
// a bad date. A local date-time is represented on a UTC axis for civil math only.
function civilTime(value: string, kind: 'date' | 'local' | 'utc' | 'timed'): number | null {
  const parts = (kind === 'date' ? DATE : DATE_TIME).exec(value)
  if (!parts || (kind === 'local' && parts[7]) || (kind === 'utc' && !parts[7])) return null
  const [, year, month, day, hour = '0', minute = '0', second = '0'] = parts
  const ms = Date.UTC(+year!, +month! - 1, +day!, +hour, +minute, +second)
  const date = new Date(ms)
  return date.getUTCMonth() === +month! - 1 &&
    date.getUTCDate() === +day! &&
    date.getUTCFullYear() === +year! &&
    +hour < 24 &&
    +minute < 60 &&
    +second < 60
    ? ms
    : null
}

// Guard recurrence evidence before ICAL can discard duplicate rule parts,
// coerce partial numeric fields, or slice an invalid date into a valid one.
function eventRule(value: string): string {
  const seen = new Set<string>()
  const parts = value.split(';').map((part) => {
    const pair = /^([a-z\d-]+)=([^=]+)$/i.exec(part)
    if (!pair) malformed()
    const key = pair[1]!.toUpperCase()
    const raw = pair[2]!
    if (seen.has(key)) malformed()
    seen.add(key)
    if (key === 'COUNT' || key === 'INTERVAL') {
      if (!/^\+?\d+$/.test(raw) || !Number.isSafeInteger(+raw) || +raw < 1) malformed()
    } else if (/^BY(SECOND|MINUTE|HOUR|MONTHDAY|YEARDAY|WEEKNO|MONTH|SETPOS)$/.test(key)) {
      if (!raw.split(',').every((item) => /^[+-]?\d+$/.test(item) && Number.isSafeInteger(+item)))
        malformed()
    } else if (key === 'UNTIL') {
      const until = raw.toUpperCase()
      if (civilTime(until, until.includes('T') ? 'timed' : 'date') === null) malformed()
    }
    const token = ['FREQ', 'BYDAY', 'WKST', 'UNTIL'].includes(key) ? raw.toUpperCase() : raw
    return `${key}=${token}`
  })
  if (!seen.has('FREQ') || (seen.has('UNTIL') && seen.has('COUNT'))) malformed()
  return parts.join(';')
}

function validateRecurrenceDates(name: string, fields: string[], value: string) {
  const types = fields.filter((field) => field.startsWith('VALUE='))
  const zones = fields.filter((field) => field.startsWith('TZID='))
  if (types.length > 1 || zones.length > 1 || zones[0] === 'TZID=') malformed()
  const kind = types[0] ?? 'VALUE=DATE-TIME'
  for (const item of value.split(',')) {
    if (kind === 'VALUE=PERIOD' && name === 'RDATE') {
      const [start, end, ...rest] = item.split('/')
      if (rest.length || !start || !end || civilTime(start, 'timed') === null) malformed()
      const length = DURATION.exec(end)
      if (
        civilTime(end, 'timed') === null &&
        (!length?.slice(1).some(Boolean) || end.endsWith('T'))
      )
        malformed()
      if (zones.length && (start.endsWith('Z') || end.endsWith('Z'))) malformed()
    } else if (kind === 'VALUE=DATE') {
      if (zones.length || civilTime(item, 'date') === null) malformed()
    } else if (
      kind !== 'VALUE=DATE-TIME' ||
      civilTime(item, zones.length ? 'local' : 'timed') === null
    ) {
      malformed()
    }
  }
}

function unfoldBounded(source: string): string[] {
  if (source.length > MAX_BYTES || Buffer.byteLength(source) > MAX_BYTES) tooLarge()
  const physical = source.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (physical.length > MAX_LINES) tooLarge()
  const logical: string[] = []
  let length = 0
  for (const line of physical) {
    const bytes = Buffer.byteLength(line)
    if (bytes > MAX_LINE_BYTES) tooLarge()
    if (/[\r\0]/.test(line)) malformed()
    if (/^[ \t]/.test(line)) {
      if (!logical.at(-1)) malformed()
      length += bytes - 1
      if (length > MAX_LINE_BYTES) tooLarge()
      logical[logical.length - 1] += line.slice(1)
    } else {
      length = bytes
      logical.push(line)
    }
  }
  return logical.filter(Boolean)
}

type ZoneInput = {
  id: string
  observances: { kind: 'STANDARD' | 'DAYLIGHT'; fields: Map<string, string[]> }[]
}

function inspectCalendar(lines: string[]) {
  const body: string[] = []
  const zones = new Map<string, ZoneInput>()
  const stack: string[] = []
  let zone: ZoneInput | undefined
  let observances = 0
  let components = 0
  let firstYear = Infinity
  let lastYear = -Infinity

  for (const line of lines) {
    // Recognize structure and only the wire fields that must be checked before
    // conversion. ICAL still parses content, parameters, escaping and values.
    const property = /^([a-z\d-]+)(;(?:[^":]|"[^"]*")*)?:/i.exec(line)
    if (!property) malformed()
    const name = property[1]!.toUpperCase()
    const params = (property[2] ?? '').toUpperCase()
    const value = line.slice(property[0].length)
    const parent = stack.at(-1)
    if (name === 'BEGIN' || name === 'END') {
      if (params || !/^[a-z\d-]+$/i.test(value)) malformed()
      const kind = value.toUpperCase()
      if (name === 'BEGIN') {
        if (++components > MAX_COMPONENTS || stack.length >= MAX_DEPTH) tooLarge()
        if (
          (!parent && (components !== 1 || kind !== 'VCALENDAR')) ||
          (parent && kind === 'VCALENDAR') ||
          (kind === 'VEVENT' && parent !== 'VCALENDAR')
        )
          malformed()
        if (kind === 'VTIMEZONE') {
          if (parent !== 'VCALENDAR' || zone) unsupportedZone()
          if (zones.size >= MAX_ZONES) tooLarge()
          zone = { id: '', observances: [] }
        } else if (zone) {
          if (parent !== 'VTIMEZONE' || (kind !== 'STANDARD' && kind !== 'DAYLIGHT'))
            unsupportedZone()
          if (++observances > MAX_OBSERVANCES) tooLarge()
          zone.observances.push({ kind, fields: new Map() })
        }
        stack.push(kind)
        if (!zone) body.push(line)
      } else {
        if (stack.pop() !== kind) malformed()
        if (!zone) body.push(line)
        if (kind === 'VTIMEZONE') {
          if (!zone?.id || !zone.observances.length || zones.has(zone.id)) unsupportedZone()
          zones.set(zone.id, zone)
          zone = undefined
        }
      }
      continue
    }
    if (!parent) malformed()
    if (zone) {
      if (
        name.startsWith('X-') ||
        name === 'COMMENT' ||
        name === 'TZNAME' ||
        name === 'LAST-MODIFIED' ||
        name === 'TZURL'
      )
        continue
      if (parent === 'VTIMEZONE') {
        if (name !== 'TZID' || params || zone.id || !value.trim() || /[\\\x00-\x1f]/.test(value))
          unsupportedZone()
        zone.id = value
      } else {
        if (
          !['DTSTART', 'TZOFFSETFROM', 'TZOFFSETTO', 'RRULE', 'RDATE'].includes(name) ||
          (params && !((name === 'DTSTART' || name === 'RDATE') && params === ';VALUE=DATE-TIME'))
        )
          unsupportedZone()
        const fields = zone.observances.at(-1)!.fields
        const values = fields.get(name) ?? []
        if (name !== 'RDATE' && values.length) unsupportedZone()
        const additions = name === 'RDATE' ? value.split(',') : [value]
        if (values.length + additions.length > 64) tooLarge()
        fields.set(name, values.concat(additions))
      }
      continue
    }
    if (parent === 'VEVENT') {
      if (
        name === 'SEQUENCE' &&
        ((params && params !== ';VALUE=INTEGER') ||
          !/^\+?\d+$/.test(value) ||
          Number(value) > 2_147_483_647)
      )
        throw new CalendarPartError('Invitation has an invalid sequence')
      if (
        name === 'DTSTAMP' &&
        ((params && params !== ';VALUE=DATE-TIME') || civilTime(value, 'utc') === null)
      )
        throw new CalendarPartError('Invitation has an invalid revision timestamp')
      if (name === 'RRULE') {
        body.push(line.slice(0, property[0].length) + eventRule(value))
        continue
      }
      if (['ATTENDEE', 'DTSTART', 'DTEND', 'RECURRENCE-ID', 'RDATE', 'EXDATE'].includes(name)) {
        const recurrenceDate = name === 'RDATE' || name === 'EXDATE'
        const fields = params
          .replace(/"([^"]*)"/g, (_, quoted: string) =>
            recurrenceDate ? quoted.replace(/;/g, ':') : '""',
          )
          .split(';')
          .slice(1)
        if (name === 'ATTENDEE') {
          // ICAL keeps only one value for repeated scalar parameters. Reject
          // them before ambiguous response evidence can be silently discarded.
          if (
            ['PARTSTAT=', 'RSVP='].some(
              (key) => fields.filter((param) => param.startsWith(key)).length > 1,
            )
          )
            malformed()
        } else if (recurrenceDate) {
          validateRecurrenceDates(name, fields, value)
        } else {
          const valueType = fields.filter((param) => param.startsWith('VALUE='))
          if (
            valueType.length > 1 ||
            (valueType[0] && !/^VALUE=(DATE|DATE-TIME)$/.test(valueType[0])) ||
            fields.filter((param) => param.startsWith('TZID=')).length > 1 ||
            fields.filter((param) => param.startsWith('RANGE=')).length > 1 ||
            civilTime(value, valueType[0] === 'VALUE=DATE' ? 'date' : 'timed') === null
          )
            malformed()
          const year = Number(value.slice(0, 4))
          firstYear = Math.min(firstYear, year)
          lastYear = Math.max(lastYear, year)
        }
      }
      if (name === 'DURATION') {
        const parts = DURATION.exec(value)
        if (
          !parts ||
          !parts.slice(1).some(Boolean) ||
          parts.slice(1).some((part) => part && part.length > 3) ||
          value.endsWith('T')
        )
          malformed()
        const [, w = '0', d = '0', h = '0', m = '0', s = '0'] = parts
        if (+w * 7 + +d + +h / 24 + +m / 1440 + +s / 86400 > 366) tooLarge()
      }
    }
    body.push(line)
  }
  if (stack.length || !components) malformed()
  return {
    body,
    zones,
    firstYear: Number.isFinite(firstYear) ? firstYear : 2000,
    lastYear: Number.isFinite(lastYear) ? lastYear : 2000,
  }
}

type Offset = { wire: string; ms: number }

function zoneOffset(value: string | undefined): Offset {
  const parts = /^([+-])([01]\d|2[0-3])([0-5]\d)(?:00)?$/.exec(value ?? '')
  // ical.js represents minute-resolution offsets only.
  if (!parts || value?.startsWith('-0000')) unsupportedZone()
  const [, sign, hour, minute] = parts
  const minutes = (sign === '-' ? -1 : 1) * (+hour! * 60 + +minute!)
  if (minutes < -720 || minutes > 840) unsupportedZone() // ICAL wraps out-of-range offsets.
  return { wire: `${sign}${hour}:${minute}`, ms: minutes * 60_000 }
}

type AnnualRule = { on: (year: number) => number; until: number }

// Deliberately not a recurrence engine: one month and one guaranteed day each
// year, at DTSTART's wall clock. Support the ordinal and BYSETPOS spellings of
// common Outlook/Apple rules, plus one month-day. Never hand an RRULE to ICAL.
function annualRule(value: string, anchor: number): AnnualRule {
  const rule = new Map<string, string>()
  for (const part of value.toUpperCase().split(';')) {
    const pair = /^(FREQ|INTERVAL|BYMONTH|BYDAY|BYSETPOS|BYMONTHDAY|UNTIL|WKST)=([^=]+)$/.exec(part)
    if (!pair || rule.has(pair[1]!)) unsupportedZone()
    rule.set(pair[1]!, pair[2]!)
  }
  const interval = rule.get('INTERVAL')
  const month = rule.get('BYMONTH') ?? ''
  const week = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
  if (
    rule.get('FREQ') !== 'YEARLY' ||
    (interval && interval !== '1') ||
    !/^(?:[1-9]|1[0-2])$/.test(month) ||
    (rule.has('WKST') && !week.includes(rule.get('WKST')!))
  )
    unsupportedZone()
  const monthIndex = Number(month) - 1
  const anchorDate = new Date(anchor)
  const clock =
    anchor -
    Date.UTC(anchorDate.getUTCFullYear(), anchorDate.getUTCMonth(), anchorDate.getUTCDate())
  const untilValue = rule.get('UNTIL')
  const until = untilValue === undefined ? Infinity : civilTime(untilValue, 'utc')
  if (until === null) unsupportedZone()
  if (rule.has('BYDAY')) {
    const byDay = /^([+-]?[1-4])?(SU|MO|TU|WE|TH|FR|SA)$/.exec(rule.get('BYDAY')!)
    const position = rule.get('BYSETPOS')
    if (
      !byDay ||
      rule.has('BYMONTHDAY') ||
      (byDay[1] ? position !== undefined : !/^[+-]?[1-4]$/.test(position ?? ''))
    )
      unsupportedZone()
    const ordinal = Number(byDay[1] ?? position)
    const day = week.indexOf(byDay[2]!)
    return {
      until,
      on(year) {
        const edge = ordinal > 0 ? Date.UTC(year, monthIndex, 1) : Date.UTC(year, monthIndex + 1, 0)
        const weekday = new Date(edge).getUTCDay()
        const delta =
          ordinal > 0
            ? ((day - weekday + 7) % 7) + 7 * (ordinal - 1)
            : -((weekday - day + 7) % 7) + 7 * (ordinal + 1)
        return edge + delta * DAY_MS + clock
      },
    }
  }
  const monthDay = rule.get('BYMONTHDAY') ?? String(anchorDate.getUTCDate())
  if (
    rule.has('BYSETPOS') ||
    !/^[+-]?[1-9]\d?$/.test(monthDay) ||
    Math.abs(Number(monthDay)) > new Date(Date.UTC(2001, monthIndex + 1, 0)).getUTCDate()
  )
    unsupportedZone()
  const day = Number(monthDay)
  return {
    until,
    on: (year) =>
      (day > 0 ? Date.UTC(year, monthIndex, day) : Date.UTC(year, monthIndex + 1, day + 1)) + clock,
  }
}

type Transition = { wall: number; kind: 'STANDARD' | 'DAYLIGHT'; from: Offset; to: Offset }
const instantOf = ({ wall, from }: Transition) => wall - from.ms

type FiniteZones = Map<string, Transition[]>

function materializeZones(scope: ReturnType<typeof inspectCalendar>): FiniteZones {
  const zones: FiniteZones = new Map()
  if (!scope.zones.size) return zones
  if (scope.lastYear - scope.firstYear + 1 > MAX_ZONE_YEARS || scope.lastYear > 9996) tooLarge()
  // Cover the prior season, up to a year of DURATION, and year crossings.
  const first = scope.firstYear - 1
  const last = scope.lastYear + 2
  const lower = Date.UTC(first, 0, 1)
  const upper = Date.UTC(last + 1, 0, 1)
  let work = 0
  for (const { id, observances } of scope.zones.values()) {
    const transitions = new Map<number, Transition>()
    let prior: Transition | undefined
    let next: Transition | undefined
    for (const { kind, fields } of observances) {
      const anchor = civilTime(fields.get('DTSTART')?.[0] ?? '', 'local')
      const from = zoneOffset(fields.get('TZOFFSETFROM')?.[0])
      const to = zoneOffset(fields.get('TZOFFSETTO')?.[0])
      if (anchor === null) unsupportedZone()
      const add = (wall: number) => {
        const transition = { wall, kind, from, to }
        const instant = instantOf(transition)
        if (instant < lower) {
          if (!prior || instant > instantOf(prior)) prior = transition
          else if (
            instant === instantOf(prior) &&
            (prior.to.ms !== to.ms || prior.from.ms !== from.ms || prior.kind !== kind)
          )
            unsupportedZone()
        } else if (instant < upper) {
          const existing = transitions.get(instant)
          if (
            existing &&
            (existing.to.ms !== to.ms || existing.from.ms !== from.ms || existing.kind !== kind)
          )
            unsupportedZone()
          transitions.set(instant, transition)
        } else if (!next || instant < instantOf(next)) {
          next = transition
        }
      }
      const charge = () => {
        if (++work > MAX_TRANSITION_WORK) tooLarge()
      }
      charge()
      add(anchor)
      for (const value of fields.get('RDATE') ?? []) {
        charge()
        const date = civilTime(value, 'local')
        if (date === null) unsupportedZone()
        add(date)
      }
      const rawRule = fields.get('RRULE')?.[0]
      if (rawRule !== undefined) {
        const rule = annualRule(rawRule, anchor)
        if (rule.until < anchor - from.ms) unsupportedZone()
        const anchorYear = new Date(anchor).getUTCFullYear()
        // Jump straight to the window or to the year of a historical UNTIL. A
        // neighbouring year covers UTC/local rollover and the prior season.
        const untilYear = Number.isFinite(rule.until)
          ? new Date(rule.until + from.ms).getUTCFullYear()
          : last + 1
        const start = Math.max(anchorYear, Math.min(first, untilYear) - 2)
        for (let year = start; year <= Math.min(last + 1, untilYear); year++) {
          charge()
          const occurrence = rule.on(year)
          if (occurrence >= anchor && occurrence - from.ms <= rule.until) add(occurrence)
        }
      }
    }
    const known = [...transitions.values()].sort((a, b) => instantOf(a) - instantOf(b))
    if (prior) known.unshift(prior)
    let offset = (known[0] ?? next)?.from
    if (!offset) unsupportedZone()
    // Before its first known change, ICAL defaults to zero; VTIMEZONE instead
    // specifies TZOFFSETFROM. Seed the bounded definition with that offset.
    known.unshift({
      kind: 'STANDARD',
      wall: Math.min(lower, known[0]?.wall ?? lower) - 2 * DAY_MS,
      from: offset,
      to: offset,
    })
    for (const change of known) {
      if (change.from.ms !== offset.ms) unsupportedZone()
      offset = change.to
    }
    zones.set(id, known)
  }
  return zones
}

function installZones(calendar: ICAL.Component, zones: FiniteZones) {
  for (const [id, transitions] of zones) {
    const definition = new ICAL.Component('vtimezone')
    definition.addPropertyWithValue('tzid', id)
    const groups = new Map<string, ICAL.Component>()
    for (const { kind, wall, from, to } of transitions) {
      const key = `${kind}/${from.wire}/${to.wire}`
      const date = ICAL.Time.fromDateTimeString(new Date(wall).toISOString().slice(0, 19))
      let observance = groups.get(key)
      if (!observance) {
        observance = new ICAL.Component(kind.toLowerCase())
        observance.addPropertyWithValue('dtstart', date)
        observance.addPropertyWithValue('tzoffsetfrom', ICAL.UtcOffset.fromString(from.wire))
        observance.addPropertyWithValue('tzoffsetto', ICAL.UtcOffset.fromString(to.wire))
        definition.addSubcomponent(observance)
        groups.set(key, observance)
      }
      // ICAL's timezone implementation consumes only the first value per RDATE.
      observance.addPropertyWithValue('rdate', date)
    }
    calendar.addSubcomponent(definition)
  }
}

function dateOf(time: ICAL.Time, property: ICAL.Property | null, zones: FiniteZones): string {
  const tzid = property?.getParameter('tzid')
  if (tzid !== undefined) {
    const raw: unknown = property?.toJSON()[3]
    if (
      typeof tzid !== 'string' ||
      !tzid ||
      time.isDate ||
      (typeof raw === 'string' && raw.endsWith('Z'))
    )
      malformed()
    const transitions = zones.get(tzid)
    if (!transitions) {
      // Many senders omit VTIMEZONE for IANA names. Don't fall back to floating
      // time or accept an offset string in place of a named zone.
      try {
        if (!/^[a-z][a-z\d_+./-]*$/i.test(tzid)) unsupportedZone()
        const zone = new Intl.DateTimeFormat('en', { timeZone: tzid }).resolvedOptions().timeZone
        return new Date(
          new TZDate(
            time.year,
            time.month - 1,
            time.day,
            time.hour,
            time.minute,
            time.second,
            zone,
          ).getTime(),
        ).toISOString()
      } catch {
        unsupportedZone()
      }
    }
    // RFC 5545 uses the offset before the change for either the repeated
    // hour or the skipped hour. ICAL otherwise may prefer standard over DST.
    const wallTime = Date.UTC(
      time.year,
      time.month - 1,
      time.day,
      time.hour,
      time.minute,
      time.second,
    )
    for (const { wall, from, to } of transitions) {
      const after = wall + to.ms - from.ms
      if (wallTime >= Math.min(wall, after) && wallTime < Math.max(wall, after))
        return new Date(wallTime - from.ms).toISOString()
    }
  }
  // A floating DATE-TIME names a wall clock, not an instant in the host zone.
  return time.isDate || time.zone === ICAL.Timezone.localTimezone
    ? time.toString()
    : time.toJSDate().toISOString()
}

/** Read only bounded calendar parts. Prepare zones after the caller recognizes the method. */
export function openCalendarPart(source: string) {
  const scope = inspectCalendar(unfoldBounded(source))
  const calendar = new ICAL.Component(ICAL.parse(scope.body.join('\r\n')))
  return {
    calendar,
    resolveTimes(): ResolveTime {
      const zones = materializeZones(scope)
      installZones(calendar, zones)
      return (time, property) => dateOf(time, property, zones)
    },
  }
}
