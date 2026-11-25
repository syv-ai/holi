import { createHash } from 'node:crypto'
import { TZDate } from '@date-fns/tz'
import ICAL from 'ical.js'
import {
  conferenceUrlIn,
  googleEventUrl,
  httpsLink,
  providerConferenceUrl,
} from '../shared/meeting-links'
import type { InviteAnswer } from './calendar'

export type MailInvitationIdentity = {
  /** Gmail parent locator, not part of the iTIP revision. */
  messageId: string
  uid: string
  sequence: number
  dtstamp: string | null
  materialKey: string | null
  /** Original occurrence: a date, floating wall clock or ISO instant, never the moved start. */
  recurrenceId: string | null
}

type LinkSource = 'mail' | 'provider' | 'calendar' | null

type MailInvitationDetails = {
  identity: MailInvitationIdentity
  title: string
  start: string | null
  end: string | null
  allDay: boolean
  /** An occurrence has a recurrenceId; a recurring event without one is the series. */
  recurring: boolean
  organizer: { email: string; name?: string } | null
  location: string | null
  conferenceUrl: string | null
  conferenceLinkSource: LinkSource
  htmlLink: string | null
  htmlLinkSource: LinkSource
  cancelled: boolean
  unavailableReason: string | null
}

type AttendeeState = { responseStatus: 'needsAction' | InviteAnswer; rsvp: boolean | null }

type ExplicitFields = {
  title: boolean
  start: boolean
  end: boolean
  location: boolean
  conferenceUrl: boolean
  htmlLink: boolean
}

type TimeKind = 'date' | 'floating' | 'instant'

type ParsedInvitation = {
  /** Validated independently of actionability (including non-answerable CANCELs). */
  method: 'REQUEST' | 'CANCEL' | null
  details: MailInvitationDetails
  /** Never crosses the capability seam. Only present for a usable REQUEST. */
  request: {
    attendees: string[]
    attendeeStates: Record<string, AttendeeState>
    /** Fields supplied by the organizer, not synthesized display defaults. */
    explicitFields: ExplicitFields
    recurrenceKind: TimeKind | null
    reply: (email: string, answer: InviteAnswer) => string
  } | null
}

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

class CalendarPartError extends Error {}

function malformed(): never {
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
      if (name === 'ATTENDEE' || ['DTSTART', 'DTEND', 'RECURRENCE-ID'].includes(name)) {
        const fields = params
          .replace(/"[^"]*"/g, '""')
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
        const parts =
          /^\+?P(?:(\d{1,3})W|(?:(\d{1,3})D)?(?:T(?:(\d{1,3})H)?(?:(\d{1,3})M)?(?:(\d{1,3})S)?)?)$/.exec(
            value,
          )
        if (!parts || !parts.slice(1).some(Boolean) || value.endsWith('T')) malformed()
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

/** Only a single SMTP address, not a header address list or a mailto query. */
function mailbox(value: unknown): string | null {
  if (typeof value !== 'string' || !/^mailto:/i.test(value)) return null
  const email = value.slice(7)
  return /^[\w.!#$&'*+\-/=^`{|}~]+@[a-z\d-]+(?:\.[a-z\d-]+)*$/i.test(email)
    ? email.toLowerCase()
    : null
}

function methodOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim().toUpperCase() : undefined
}

function calendarOf(scope: ReturnType<typeof inspectCalendar>): ICAL.Component {
  return new ICAL.Component(ICAL.parse(scope.body.join('\r\n')))
}

function single(entry: ICAL.Component, key: string): ICAL.Property | null {
  const items = entry.getAllProperties(key)
  if (items.length > 1) throw new CalendarPartError('Invitation has ambiguous calendar fields')
  return items[0] ?? null
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

function timeKind(value: string): TimeKind {
  return value.length === 10 ? 'date' : value.endsWith('Z') ? 'instant' : 'floating'
}

function eventTime(property: ICAL.Property | null): ICAL.Time | null {
  if (!property) return null
  if (property.type !== 'date' && property.type !== 'date-time') malformed()
  const value = property.getFirstValue()
  if (!(value instanceof ICAL.Time) || value.isDate !== (property.type === 'date')) malformed()
  return value
}

function identityOf(
  messageId: string,
  event: ICAL.Component,
  zones: FiniteZones,
): MailInvitationIdentity {
  const uid = single(event, 'uid')?.getFirstValue()
  if (typeof uid !== 'string' || !uid.trim())
    throw new CalendarPartError('Invitation has no usable UID')
  const sequence = single(event, 'sequence')?.getFirstValue() ?? 0
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0)
    throw new CalendarPartError('Invitation has an invalid sequence')
  const recurrence = single(event, 'recurrence-id')
  const occurrence = eventTime(recurrence)
  const stamp = single(event, 'dtstamp')
  const dtstamp = eventTime(stamp)
  if (dtstamp && (dtstamp.isDate || dtstamp.zone !== ICAL.Timezone.utcTimezone)) malformed()
  return {
    messageId,
    uid,
    sequence,
    materialKey: null,
    dtstamp: dtstamp ? dateOf(dtstamp, stamp, zones) : null,
    recurrenceId: occurrence ? dateOf(occurrence, recurrence, zones) : null,
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function attendeeState(property: ICAL.Property): AttendeeState {
  const partstat = property.getParameter('partstat')
  const rsvp = property.getParameter('rsvp')
  const status = methodOf(partstat)
  const flag = methodOf(rsvp)
  if (rsvp !== undefined && flag !== 'TRUE' && flag !== 'FALSE') malformed()
  const responseStatus =
    partstat === undefined || status === 'NEEDS-ACTION'
      ? 'needsAction'
      : (Object.keys(PARTSTAT) as InviteAnswer[]).find((answer) => PARTSTAT[answer] === status)
  // An unknown explicit response is not evidence of needsAction.
  if (!responseStatus) malformed()
  return { responseStatus, rsvp: rsvp === undefined ? null : flag === 'TRUE' }
}

function attendeeEvidence(entry: ICAL.Component) {
  const states = new Map<string, AttendeeState>()
  for (const property of entry.getAllProperties('attendee')) {
    const email = mailbox(property.getFirstValue())
    if (!email) continue
    const state = attendeeState(property)
    const previous = states.get(email)
    if (
      previous &&
      (previous.responseStatus !== state.responseStatus || previous.rsvp !== state.rsvp)
    )
      throw new CalendarPartError('Invitation has conflicting attendee responses')
    states.set(email, state)
  }
  const attendees = [...states.keys()].sort()
  return {
    attendees,
    attendeeStates: Object.fromEntries(attendees.map((email) => [email, states.get(email)!])),
  }
}

function candidate(events: ICAL.Component[]): ICAL.Component | undefined {
  if (events.length <= 1) return events[0]
  const masters = events.filter((event) => !event.hasProperty('recurrence-id'))
  const master = masters[0]
  // A series plus its exceptions is one series invitation. Independent events
  // or several instance-only updates have no single answer.
  if (
    master &&
    masters.length === 1 &&
    events.every(
      (event) => event.getFirstPropertyValue('uid') === master.getFirstPropertyValue('uid'),
    )
  )
    return master
  return undefined
}

function eventMaterial(entry: ICAL.Component, zones: FiniteZones, hasExceptions = false) {
  const status = methodOf(single(entry, 'status')?.getFirstValue()) ?? null
  const summary = single(entry, 'summary')
  const locationProperty = single(entry, 'location')
  const urlProperty = single(entry, 'url')
  const conferenceProperties = entry.getAllProperties('conference')
  const title = text(summary?.getFirstValue()) ?? 'Meeting invitation'
  const location = text(locationProperty?.getFirstValue()) ?? null
  const description = text(single(entry, 'description')?.getFirstValue())
  const htmlLink = httpsLink(urlProperty?.getFirstValue())
  const urlConference = htmlLink ? providerConferenceUrl(htmlLink) : null
  const htmlLinkSource: LinkSource = !htmlLink
    ? null
    : urlConference || googleEventUrl(htmlLink)
      ? 'provider'
      : 'mail'
  // RFC 7986 permits multiple access points, including telephone dial-in.
  // Rank recognized video links first and break ties independently of wire order.
  const conferenceLinks = conferenceProperties
    .flatMap((property) => httpsLink(property.getFirstValue()) ?? [])
    .sort()
  const providerLink =
    conferenceLinks.map(providerConferenceUrl).find((link) => link !== null) ??
    urlConference ??
    conferenceUrlIn(description ?? '') ??
    conferenceUrlIn(location ?? '')
  const conferenceUrl = providerLink ?? conferenceLinks[0] ?? null
  const conferenceLinkSource: LinkSource = providerLink ? 'provider' : conferenceUrl ? 'mail' : null
  const organizerProperty = single(entry, 'organizer')
  const email = mailbox(organizerProperty?.getFirstValue())
  const name = text(organizerProperty?.getParameter('cn'))
  const organizer = email ? { email, ...(name ? { name } : {}) } : null
  const evidence = attendeeEvidence(entry)
  const startProperty = single(entry, 'dtstart')
  const endProperty = single(entry, 'dtend')
  const duration = single(entry, 'duration')
  if ((endProperty && duration) || (duration && duration.type !== 'duration')) malformed()
  const startTime = eventTime(startProperty)
  const endTime = eventTime(endProperty)
  if (endTime && (!startTime || startTime.isDate !== endTime.isDate)) malformed()
  const start = startTime ? dateOf(startTime, startProperty, zones) : null
  let end = endTime ? dateOf(endTime, endProperty, zones) : start
  if (start && end && timeKind(start) !== timeKind(end)) malformed()
  if (startTime && !endTime && (duration || startTime.isDate)) {
    const next = startTime.clone()
    const length = duration?.getFirstValue() ?? ICAL.Duration.fromSeconds(86400)
    if (
      !(length instanceof ICAL.Duration) ||
      (next.isDate && (length.hours || length.minutes || length.seconds))
    )
      malformed()
    // Calendar days are nominal (a DST change can move the offset). Add
    // sub-day units to the instant when known, or to the wall clock otherwise.
    next.day += length.weeks * 7 + length.days
    const seconds = length.hours * 3600 + length.minutes * 60 + length.seconds
    if (!next.isDate && start && timeKind(start) === 'floating') {
      next.second += seconds
      end = dateOf(next, startProperty, zones)
    } else {
      end = dateOf(next, startProperty, zones)
      if (!next.isDate) end = new Date(Date.parse(end) + seconds * 1000).toISOString()
    }
  }
  const recurrence = single(entry, 'recurrence-id')
  if (recurrence && startTime && startTime.isDate !== (recurrence.type === 'date')) malformed()
  const rangeParam = recurrence?.getParameter('range')
  if (rangeParam !== undefined && !methodOf(rangeParam)) malformed()
  const range = methodOf(rangeParam) ?? null
  // Preserve the recurrence description of a series, without expanding it.
  const rules = ['rrule', 'rdate', 'exdate']
    .flatMap((name) =>
      entry.getAllProperties(name).map((property) => {
        const [, params, type, ...values] = property.toJSON()
        return JSON.stringify([
          name,
          type,
          canonicalFields(params),
          values.map(canonicalFields).sort(),
        ])
      }),
    )
    .sort()
  const details = {
    title,
    location,
    htmlLink,
    htmlLinkSource,
    conferenceUrl,
    conferenceLinkSource,
    organizer,
    start,
    end,
    allDay: startTime?.isDate ?? false,
    recurring: hasExceptions || recurrence !== null || rules.length > 0,
  }
  const explicitFields: ExplicitFields = {
    title: summary !== null,
    start: startProperty !== null,
    end: endProperty !== null || duration !== null,
    location: locationProperty !== null,
    conferenceUrl: conferenceProperties.length > 0 || conferenceUrl !== null,
    htmlLink: urlProperty !== null,
  }
  return {
    details,
    explicitFields,
    ...evidence,
    description: description ?? null,
    status,
    range,
    rules,
  }
}

function canonicalFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalFields)
  if (value && typeof value === 'object')
    return Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, field]) => [key, canonicalFields(field)])
  return value
}

/** Inspect only calendar MIME payloads, not prose or a quoted earlier email. */
export function parseMailInvitation(
  messageId: string,
  source: string,
  mimeMethod: string | undefined,
): ParsedInvitation | null {
  const hint = methodOf(mimeMethod)
  let method: ParsedInvitation['method'] = null
  const details: MailInvitationDetails = {
    identity: {
      messageId,
      uid: '',
      sequence: 0,
      recurrenceId: null,
      dtstamp: null,
      materialKey: null,
    },
    title: 'Meeting invitation',
    start: null,
    end: null,
    allDay: false,
    recurring: false,
    organizer: null,
    location: null,
    conferenceUrl: null,
    conferenceLinkSource: null,
    htmlLink: null,
    htmlLinkSource: null,
    cancelled: false,
    unavailableReason: null,
  }
  const unavailable = (reason: string): ParsedInvitation => {
    details.unavailableReason = reason
    return { method, details, request: null }
  }

  try {
    const scope = inspectCalendar(unfoldBounded(source))
    const calendar = calendarOf(scope)
    const payload = single(calendar, 'method')
    const parsed = payload?.type === 'text' ? methodOf(payload.getFirstValue()) : undefined
    // PUBLISH and REPLY are not invitations. A damaged calendar MIME part with
    // no usable method is still something the reader should explain.
    if (
      parsed !== 'REQUEST' &&
      parsed !== 'CANCEL' &&
      hint !== 'REQUEST' &&
      hint !== 'CANCEL' &&
      (parsed || hint)
    )
      return null
    if ((parsed !== 'REQUEST' && parsed !== 'CANCEL') || (hint && hint !== parsed))
      return unavailable('Calendar invitation has a missing or inconsistent method')
    method = parsed
    const zones = materializeZones(scope)
    installZones(calendar, zones)
    const events = calendar.getAllSubcomponents('vevent')
    const entry = candidate(events)
    if (!entry) return unavailable('Invitation does not describe a single event or series')
    const identity = identityOf(messageId, entry, zones)
    const material = eventMaterial(entry, zones, events.length > 1)
    const exceptions = events
      .filter((item) => item !== entry)
      .map((item) => {
        const { recurrenceId } = identityOf(messageId, item, zones)
        return JSON.stringify({ recurrenceId, ...eventMaterial(item, zones) })
      })
      .sort()
    const cancelled = method === 'CANCEL' || material.status === 'CANCELLED'
    identity.materialKey = createHash('sha256')
      .update(
        JSON.stringify({
          method,
          cancelled,
          occurrence: identity.recurrenceId,
          ...material,
          exceptions,
        }),
      )
      .digest('hex')
    Object.assign(details, material.details, { identity, cancelled })
    if (cancelled) return unavailable('This invitation was cancelled')
    if (!details.organizer) return unavailable('Invitation has no usable organizer address')
    if (!details.start || !details.end || details.end < details.start)
      return unavailable('Invitation has no usable start or end time')
    if (material.range) return unavailable('This invitation changes multiple occurrences')
    const { start, organizer } = details
    return {
      method,
      details,
      request: {
        attendees: material.attendees,
        attendeeStates: material.attendeeStates,
        explicitFields: material.explicitFields,
        recurrenceKind: identity.recurrenceId ? timeKind(identity.recurrenceId) : null,
        reply: (attendee, answer) => buildReply(identity, start, organizer.email, attendee, answer),
      },
    }
  } catch (error) {
    return unavailable(
      error instanceof CalendarPartError
        ? error.message
        : 'Calendar invitation is malformed or unsupported',
    )
  }
}

const PARTSTAT = { accepted: 'ACCEPTED', tentative: 'TENTATIVE', declined: 'DECLINED' } as const

function buildReply(
  identity: MailInvitationIdentity,
  start: string,
  organizer: string,
  email: string,
  answer: InviteAnswer,
): string {
  const calendar = new ICAL.Component('vcalendar')
  calendar.addPropertyWithValue('version', '2.0')
  calendar.addPropertyWithValue('prodid', '-//Holi//Mail invitation reply//EN')
  calendar.addPropertyWithValue('method', 'REPLY')
  const reply = new ICAL.Component('vevent')
  calendar.addSubcomponent(reply)
  reply.addPropertyWithValue('uid', identity.uid)
  reply.addPropertyWithValue('sequence', identity.sequence)
  reply.addPropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true))
  reply.addPropertyWithValue('organizer', `mailto:${organizer}`)
  const attendee = reply.addPropertyWithValue('attendee', `mailto:${email}`)
  attendee.setParameter('partstat', PARTSTAT[answer])

  // Preserve DATE and floating values. Known instants go out as UTC, never a
  // TZID without its definition. The recurrence slot is independent of moved start.
  reply.addPropertyWithValue('dtstart', replyTime(start))
  if (identity.recurrenceId)
    reply.addPropertyWithValue('recurrence-id', replyTime(identity.recurrenceId))
  return calendar.toString() + '\r\n'
}

function replyTime(value: string): ICAL.Time {
  switch (timeKind(value)) {
    case 'date':
      return ICAL.Time.fromDateString(value)
    case 'floating':
      return ICAL.Time.fromDateTimeString(value)
    case 'instant':
      return ICAL.Time.fromJSDate(new Date(value), true)
  }
}

/** A sent iTIP reply can describe only this organizer, invite sequence and occurrence.
 * Its DTSTAMP belongs to the reply, not the original invitation. */
export function invitationReplyStatus(
  source: string,
  identity: MailInvitationIdentity,
  organizer: string,
  email: string,
): InviteAnswer | null {
  try {
    const scope = inspectCalendar(unfoldBounded(source))
    const reply = calendarOf(scope)
    const method = single(reply, 'method')
    if (method?.type !== 'text' || methodOf(method.getFirstValue()) !== 'REPLY') return null
    const events = reply.getAllSubcomponents('vevent')
    if (events.length !== 1) return null
    const zones = materializeZones(scope)
    installZones(reply, zones)
    const entry = events[0]!
    const sent = identityOf('', entry, zones)
    const recurrence = entry.getFirstProperty('recurrence-id')
    if (recurrence?.getParameter('range') !== undefined) return null
    // Validate any supplied times even when no recurrence ID needs their zones.
    for (const key of ['dtstart', 'dtend']) {
      const property = single(entry, key)
      const time = eventTime(property)
      if (time && recurrence && property?.type !== recurrence.type) return null
      if (time) dateOf(time, property, zones)
    }
    if (
      sent.uid !== identity.uid ||
      sent.sequence !== identity.sequence ||
      sent.recurrenceId !== identity.recurrenceId ||
      mailbox(single(entry, 'organizer')?.getFirstValue()) !== organizer
    )
      return null
    const attendees = entry.getAllProperties('attendee')
    if (attendees.length !== 1 || mailbox(attendees[0]!.getFirstValue()) !== email) return null
    const partstat = methodOf(attendees[0]!.getParameter('partstat'))
    return (
      (['accepted', 'tentative', 'declined'] as const).find(
        (answer) => PARTSTAT[answer] === partstat,
      ) ?? null
    )
  } catch {
    return null
  }
}
