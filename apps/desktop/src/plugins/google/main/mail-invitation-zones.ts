import { createHash } from 'node:crypto'
import ICAL from 'ical.js'
import { canonicalIanaZone } from '../shared/time-zones'

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
const MAX_COMPARISON_WORK = 16_384
const COMPARISON_LOOKAHEAD_YEARS = 8

export class CalendarPartError extends Error {}

export class AmbiguousCalendarValue extends CalendarPartError {
  constructor() {
    super('Calendar invitation has an ambiguous VALUE parameter')
  }
}

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

type RecurrenceTimeBasis = {
  kind: 'date' | 'floating' | 'utc' | 'iana' | 'custom'
  zone: string | null
  /** ISO civil date or date-time, without a zone or offset (including for UTC). */
  wallStart: string
  /** Complete supported VTIMEZONE rules, not just transitions near DTSTART. */
  customKey: string | null
}

export type CalendarTimes = {
  resolveTime: (time: ICAL.Time, property: ICAL.Property | null) => string
  recurrenceTimeBasis: (time: ICAL.Time, property: ICAL.Property | null) => RecurrenceTimeBasis
  recurrenceZoneKeys: (entry: ICAL.Component) => [string, string][]
  checkRecurrenceZones: (
    basis: RecurrenceTimeBasis,
    entries: ICAL.Component[],
  ) => (zone: string | null) => boolean
  replyTimes: (properties: (ICAL.Property | null)[]) => {
    properties: ReturnType<ICAL.Property['toJSON']>[]
    definitions: string[]
    unavailableReason: string | null
  }
}

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

function validateRecurrenceDates(name: string, kind: string, zones: string[], value: string) {
  if (zones.length > 1 || zones[0] === '') malformed()
  for (const item of value.split(',')) {
    if (kind === 'PERIOD' && name === 'RDATE') {
      const [start, end, ...rest] = item.split('/')
      if (rest.length || !start || !end || civilTime(start, 'timed') === null) malformed()
      const length = DURATION.exec(end)
      if (
        civilTime(end, 'timed') === null &&
        (!length?.slice(1).some(Boolean) || end.endsWith('T'))
      )
        malformed()
      if (zones.length && (start.endsWith('Z') || end.endsWith('Z'))) malformed()
    } else if (kind === 'DATE') {
      if (zones.length || civilTime(item, 'date') === null) malformed()
    } else if (kind !== 'DATE-TIME' || civilTime(item, zones.length ? 'local' : 'timed') === null) {
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
  wire: string[]
}

// Read the parameter section, never the property value. RFC 6868 encodes
// parameter quotes as ^'; only literal double quotes delimit a parameter.
// Backslash escapes in property values (e.g. a TEXT list) are ICAL's job.
function contentLine(line: string) {
  const property = /^([a-z\d-]+)/i.exec(line)
  if (!property) malformed()
  const name = property[0].toUpperCase()
  const parameters = new Map<string, string[]>()
  const param = /;([a-z\d-]+)=("[^"]*"(?:,"[^"]*")*|[^":;]*)(?=[:;])/iy
  let position = property[0].length
  while (line[position] === ';') {
    param.lastIndex = position
    const match = param.exec(line)
    if (!match) malformed()
    const key = match[1]!.toUpperCase()
    const raw = match[2]!
    // VALUE is always a single type token, on standard and extension
    // properties alike. ICAL would otherwise silently select the last one.
    if (key === 'VALUE' && (parameters.has(key) || !/^(?:[a-z\d-]+|"[a-z\d-]+")$/i.test(raw)))
      throw new AmbiguousCalendarValue()
    // ICAL only consumes separately quoted lists for these address parameters.
    // Reject mixed/unsupported quoting rather than letting ICAL see a different
    // parameter boundary than the wire guard.
    if (
      raw.startsWith('"') &&
      /^"[^"]*",/.test(raw) &&
      !['MEMBER', 'DELEGATED-TO', 'DELEGATED-FROM'].includes(key)
    )
      malformed()
    const prior = parameters.get(key) ?? []
    prior.push(raw.replace(/^"|"$/g, '').toUpperCase())
    parameters.set(key, prior)
    position = param.lastIndex
  }
  if (line[position] !== ':') malformed()
  return {
    name,
    parameters,
    params: line.slice(property[0].length, position).toUpperCase(),
    value: line.slice(position + 1),
    valueStart: position + 1,
  }
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
    const { name, params, parameters, value, valueStart } = contentLine(line)
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
          zone = { id: '', observances: [], wire: [] }
        } else if (zone) {
          if (parent !== 'VTIMEZONE' || (kind !== 'STANDARD' && kind !== 'DAYLIGHT'))
            unsupportedZone()
          if (++observances > MAX_OBSERVANCES) tooLarge()
          zone.observances.push({ kind, fields: new Map() })
        }
        stack.push(kind)
      } else if (stack.pop() !== kind) malformed()
      const destination = zone?.wire ?? body
      destination.push(line)
      if (name === 'END' && kind === 'VTIMEZONE') {
        if (!zone?.id || !zone.observances.length || zones.has(zone.id)) unsupportedZone()
        zones.set(zone.id, zone)
        zone = undefined
      }
      continue
    }
    if (!parent) malformed()
    if (zone) {
      zone.wire.push(line)
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
        body.push(line.slice(0, valueStart) + eventRule(value))
        continue
      }
      if (
        ['ORGANIZER', 'ATTENDEE', 'DTSTART', 'DTEND', 'RECURRENCE-ID', 'RDATE', 'EXDATE'].includes(
          name,
        )
      ) {
        const valueType = parameters.get('VALUE')?.[0] ?? 'DATE-TIME'
        const zones = parameters.get('TZID') ?? []
        const repeated = (key: string) => (parameters.get(key)?.length ?? 0) > 1
        if (name === 'ATTENDEE') {
          if (repeated('PARTSTAT') || repeated('RSVP')) malformed()
        } else if (name === 'RDATE' || name === 'EXDATE') {
          validateRecurrenceDates(name, valueType, zones, value)
        } else if (name !== 'ORGANIZER') {
          if (
            !/^(DATE|DATE-TIME)$/.test(valueType) ||
            zones.length > 1 ||
            repeated('RANGE') ||
            civilTime(value, valueType === 'DATE' ? 'date' : 'timed') === null
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

type AnnualRule = {
  on: (year: number) => number
  until: number
  pattern: [month: number, day: number] | [month: number, ordinal: number, weekday: number]
}

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
      pattern: [monthIndex, ordinal, day],
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
    pattern: [monthIndex, day],
    on: (year) =>
      (day > 0 ? Date.UTC(year, monthIndex, day) : Date.UTC(year, monthIndex + 1, day + 1)) + clock,
  }
}

type Transition = { wall: number; kind: 'STANDARD' | 'DAYLIGHT'; from: Offset; to: Offset }
const instantOf = ({ wall, from }: Transition) => wall - from.ms

type Observance = {
  kind: Transition['kind']
  anchor: number
  from: Offset
  to: Offset
  dates: number[]
  rule: AnnualRule | null
}

type FiniteZones = Map<
  string,
  { transitions: Transition[]; rulesKey: string; observances: Observance[]; wire: string[] }
>

function readObservance({ kind, fields }: ZoneInput['observances'][number]): Observance {
  const anchor = civilTime(fields.get('DTSTART')?.[0] ?? '', 'local')
  const from = zoneOffset(fields.get('TZOFFSETFROM')?.[0])
  const to = zoneOffset(fields.get('TZOFFSETTO')?.[0])
  if (anchor === null) unsupportedZone()
  const dates = (fields.get('RDATE') ?? []).map((value) => {
    const date = civilTime(value, 'local')
    if (date === null) unsupportedZone()
    return date
  })
  const rawRule = fields.get('RRULE')?.[0]
  const rule = rawRule === undefined ? null : annualRule(rawRule, anchor)
  if (rule && rule.until < anchor - from.ms) unsupportedZone()
  return { kind, anchor, from, to, dates, rule }
}

function zoneTransitions(
  observances: Observance[],
  first: number,
  last: number,
  charge: () => void,
): Transition[] {
  const lower = Date.UTC(first, 0, 1)
  const upper = Date.UTC(last + 1, 0, 1)
  const transitions = new Map<number, Transition>()
  let prior: Transition | undefined
  let next: Transition | undefined
  for (const { kind, anchor, from, to, dates, rule } of observances) {
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
    charge()
    add(anchor)
    for (const date of dates) {
      charge()
      add(date)
    }
    if (rule) {
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
  return known
}

function materializeZones(scope: ReturnType<typeof inspectCalendar>): FiniteZones {
  const zones: FiniteZones = new Map()
  if (!scope.zones.size) return zones
  if (scope.lastYear - scope.firstYear + 1 > MAX_ZONE_YEARS || scope.lastYear > 9996) tooLarge()
  // Cover the prior season, up to a year of DURATION, and year crossings.
  const first = scope.firstYear - 1
  const last = scope.lastYear + 2
  let work = 0
  for (const { id, observances: input, wire } of scope.zones.values()) {
    const observances = input.map(readObservance)
    const transitions = zoneTransitions(observances, first, last, () => {
      if (++work > MAX_TRANSITION_WORK) tooLarge()
    })
    const rules = observances.map(({ kind, anchor, from, to, dates, rule }) =>
      JSON.stringify([
        kind,
        anchor,
        from.ms,
        to.ms,
        [...new Set(dates)].sort((a, b) => a - b),
        rule && [rule.pattern, Number.isFinite(rule.until) ? rule.until : null],
      ]),
    )
    zones.set(id, {
      transitions,
      rulesKey: createHash('sha256').update(JSON.stringify(rules.sort())).digest('hex'),
      observances,
      wire,
    })
  }
  return zones
}

function installZones(calendar: ICAL.Component, zones: FiniteZones) {
  for (const [id, { transitions }] of zones) {
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

type Years = { first: number; last: number }

function rememberYear(refs: Map<string, Years>, id: string, year: number) {
  const previous = refs.get(id)
  refs.set(id, {
    first: Math.min(year, previous?.first ?? year),
    last: Math.max(year, previous?.last ?? year),
  })
}

function recurrenceReferences(entry: ICAL.Component): Map<string, Years> {
  const refs = new Map<string, Years>()
  for (const name of ['rdate', 'exdate', 'recurrence-id']) {
    for (const property of entry.getAllProperties(name)) {
      const tzid = property.getParameter('tzid')
      if (tzid === undefined) continue
      if (typeof tzid !== 'string' || !tzid) malformed()
      // These civil dates (including PERIOD endpoints) were checked on the wire.
      // Do not hydrate the properties or expand any event recurrence rules.
      const values: unknown[] = property.toJSON().slice(3)
      for (const value of values.flat()) {
        if (typeof value !== 'string') malformed()
        if (value.startsWith('P') || value.startsWith('+P')) continue
        const year = Number(value.slice(0, 4))
        if (!Number.isInteger(year) || year < 1000) malformed()
        rememberYear(refs, tzid, year)
      }
    }
  }
  return refs
}

function ianaOffsetReader(zone: string) {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
  return (instant: number): number => {
    const offset = formatter
      .formatToParts(instant)
      .find(({ type }) => type === 'timeZoneName')?.value
    if (offset === 'GMT') return 0
    // Historical IANA offsets need not be rounded to a minute.
    const parts = /^GMT([+-])([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(offset ?? '')
    if (!parts) unsupportedZone()
    const [, sign, h, m, s = '0'] = parts
    return (sign === '-' ? -1 : 1) * (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000
  }
}

function ianaInstant(wall: number, zone: string): number {
  const offsetAt = ianaOffsetReader(zone)
  // Treat the wall clock as UTC only for arithmetic. Probe a day either way
  // (beyond IANA's UTC offsets) to get candidates on either side of a change.
  const before = offsetAt(wall - DAY_MS)
  const after = offsetAt(wall + DAY_MS)
  const earlier = wall - Math.max(before, after)
  const later = wall - Math.min(before, after)
  const earlierOffset = offsetAt(earlier)
  // If both candidates round-trip, RFC 5545 chooses the first occurrence.
  if (earlier + earlierOffset === wall) return earlier
  const laterOffset = offsetAt(later)
  if (later + laterOffset === wall) return later

  if (before < after && earlierOffset === before && laterOffset === after) {
    // Prove the skipped wall clock straddles a forward transition at wire
    // precision. RFC 5545 uses that transition's old offset (the later instant).
    let low = earlier
    let high = later
    while (high - low > 1000) {
      const probe = low + Math.floor((high - low) / 2000) * 1000
      const offset = offsetAt(probe)
      if (offset === before) low = probe
      else if (offset === after) high = probe
      else unsupportedZone()
    }
    if (wall >= high + before && wall < high + after) return later
  }
  unsupportedZone()
}

function equivalentObservances(
  observances: Observance[],
  name: string,
  { first, last }: Years,
  charge: () => void,
): boolean {
  // Compare from the first referenced civil year through eight full years
  // beyond the latest reference, anchor, explicit change or rule expiry. The
  // tail checks the continuing annual pattern, not future tzdb or civil law.
  // Refuse definitions with a later regime that cannot fit this bounded check.
  let latest = Date.UTC(last, 0, 1)
  for (const { anchor, dates, rule, from } of observances) {
    latest = Math.max(latest, anchor - from.ms)
    for (const date of dates) latest = Math.max(latest, date - from.ms)
    if (rule && Number.isFinite(rule.until)) latest = Math.max(latest, rule.until)
  }
  const lastRegime = new Date(latest).getUTCFullYear()
  const through = lastRegime + COMPARISON_LOOKAHEAD_YEARS
  if (lastRegime - first + 1 > MAX_ZONE_YEARS || through >= 9999) return false

  const transitions = zoneTransitions(observances, first - 1, through, charge)
  const lower = Date.UTC(first, 0, 1) - DAY_MS
  const upper = Date.UTC(through + 1, 0, 1)
  const offsetAt = ianaOffsetReader(name)
  const agrees = (at: number, offset: number) => {
    charge()
    return offsetAt(at) === offset
  }
  // Check both sides of every advertised transition at wire precision. Also
  // scan daily for missing IANA seasons. Intl has no transition iterator; a
  // paired IANA change entirely between daily probes is outside this policy.
  let sample = lower
  let offset = transitions[0]!.from.ms
  for (const transition of transitions) {
    const at = instantOf(transition)
    if (at >= upper) break
    if (at >= lower && transition.from.ms !== transition.to.ms) {
      if (!agrees(at - 1000, offset) || !agrees(at, transition.to.ms)) return false
    }
    while (sample < at) {
      if (!agrees(sample, offset)) return false
      sample += DAY_MS
    }
    offset = transition.to.ms
  }
  while (sample < upper) {
    if (!agrees(sample, offset)) return false
    sample += DAY_MS
  }
  return true
}

function resolvedTimes(zones: FiniteZones): CalendarTimes {
  const namedZones = new Map<string, string | null>()
  const refsByEvent = new WeakMap<ICAL.Component, Map<string, Years>>()
  function references(entry: ICAL.Component) {
    let refs = refsByEvent.get(entry)
    if (!refs) {
      refs = recurrenceReferences(entry)
      refsByEvent.set(entry, refs)
    }
    return refs
  }
  function knownZone(id: string | null): string | null {
    if (id === null) return null
    const cached = namedZones.get(id)
    if (cached !== undefined) return cached
    const zone = canonicalIanaZone(id)
    namedZones.set(id, zone)
    return zone
  }

  function recurrenceTimeBasis(
    time: ICAL.Time,
    property: ICAL.Property | null,
  ): RecurrenceTimeBasis {
    const tzid = property?.getParameter('tzid')
    const wallStart = time.toString().replace(/Z$/, '')
    if (tzid === undefined) {
      const utc = time.zone === ICAL.Timezone.utcTimezone
      return {
        kind: time.isDate ? 'date' : utc ? 'utc' : 'floating',
        zone: utc ? 'UTC' : null,
        wallStart,
        customKey: null,
      }
    }
    const raw: unknown = property?.toJSON()[3]
    if (
      typeof tzid !== 'string' ||
      !tzid ||
      time.isDate ||
      (typeof raw === 'string' && raw.endsWith('Z'))
    )
      malformed()
    const custom = zones.get(tzid)
    if (custom) return { kind: 'custom', zone: tzid, wallStart, customKey: custom.rulesKey }
    // An embedded definition takes precedence even when it uses an IANA name.
    // Without one, only trust names that Intl can canonicalize.
    const zone = knownZone(tzid)
    if (!zone) unsupportedZone()
    return { kind: zone === 'UTC' ? 'utc' : 'iana', zone, wallStart, customKey: null }
  }

  return {
    recurrenceTimeBasis,
    recurrenceZoneKeys(entry) {
      return [...references(entry).keys()].sort().flatMap((id) => {
        const definition = zones.get(id)
        return definition ? [[id, definition.rulesKey]] : []
      })
    },
    checkRecurrenceZones(basis, entries) {
      const refs = new Map<string, Years>()
      for (const entry of entries) {
        for (const [id, { first, last }] of references(entry)) {
          rememberYear(refs, id, first)
          rememberYear(refs, id, last)
        }
      }
      if (basis.kind === 'custom' && basis.zone)
        rememberYear(refs, basis.zone, Number(basis.wallStart.slice(0, 4)))
      let verified: boolean | undefined
      return (zone) => {
        const actual = knownZone(zone)
        if (basis.kind === 'floating') return false
        if (
          basis.kind === 'date'
            ? zone !== null && !actual
            : !actual || actual !== knownZone(basis.zone)
        )
          return false
        if (verified !== undefined) return verified
        let work = 0
        try {
          verified = [...refs].every(([id, years]) => {
            const name = knownZone(id)
            const definition = zones.get(id)
            return (
              name !== null &&
              (!definition ||
                equivalentObservances(definition.observances, name, years, () => {
                  if (++work > MAX_COMPARISON_WORK) tooLarge()
                }))
            )
          })
        } catch (error) {
          if (!(error instanceof CalendarPartError)) throw error
          verified = false
        }
        return verified
      }
    },
    replyTimes(fields) {
      const definitions = new Map<string, string[]>()
      let unavailableReason: string | null = null
      const properties = fields.flatMap((property) => {
        if (!property) return []
        const [name, , type, value] = property.toJSON()
        const id = property.getParameter('tzid')
        if (typeof id === 'string') {
          const definition = zones.get(id)
          if (!definition) {
            // DTSTART is optional in a REPLY, but RECURRENCE-ID is required
            // to identify the occurrence and its TZID needs a definition.
            if (name === 'recurrence-id')
              unavailableReason =
                'This occurrence cannot be answered by email without its time zone definition'
            return []
          }
          definitions.set(id, definition.wire)
        }
        // Keep the original value and its TZID, not the hydrated ICAL.Time or
        // arbitrary parameters from the organizer. Never serialize our finite
        // conversion table in place of the original supported definition.
        return [[name, id === undefined ? {} : { tzid: id }, type, value]]
      })
      return {
        properties,
        unavailableReason,
        definitions: [...definitions.values()].map((lines) =>
          lines.map(ICAL.helpers.foldline).join('\r\n'),
        ),
      }
    },
    resolveTime(time, property) {
      const basis = recurrenceTimeBasis(time, property)
      switch (basis.kind) {
        case 'date':
        case 'floating':
          // A floating DATE-TIME names a wall clock, not an instant in the host zone.
          return basis.wallStart
        case 'utc':
          return new Date(basis.wallStart + 'Z').toISOString()
        case 'iana':
          return new Date(ianaInstant(Date.parse(basis.wallStart + 'Z'), basis.zone!)).toISOString()
        case 'custom': {
          // RFC 5545 uses the offset before the change for either the repeated
          // hour or the skipped hour. ICAL otherwise may prefer standard over DST.
          const wallTime = Date.parse(basis.wallStart + 'Z')
          for (const { wall, from, to } of zones.get(basis.zone!)!.transitions) {
            const after = wall + to.ms - from.ms
            if (wallTime >= Math.min(wall, after) && wallTime < Math.max(wall, after))
              return new Date(wallTime - from.ms).toISOString()
          }
          return time.toJSDate().toISOString()
        }
      }
    },
  }
}

/** Read only bounded calendar parts. Prepare zones after the caller recognizes the method. */
export function openCalendarPart(source: string) {
  const scope = inspectCalendar(unfoldBounded(source))
  const calendar = new ICAL.Component(ICAL.parse(scope.body.join('\r\n')))
  return {
    calendar,
    resolveTimes(): CalendarTimes {
      const zones = materializeZones(scope)
      installZones(calendar, zones)
      return resolvedTimes(zones)
    },
  }
}
