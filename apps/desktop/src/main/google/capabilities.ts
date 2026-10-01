/**
 * Google's capabilities: a vault app's read of the connected calendar and
 * mail. The app door only: the agent has `holi-google`, and its own gate.
 * Each read is one person's data, so each names its `appGrant`: the app must
 * declare it and the person approve it, which the app door checks.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { CapabilityError, unavailable } from '../capabilities/error'
import { paramsObject, stringParam } from '../capabilities/params'
import { cap } from '../capabilities/registry'
import type { CalendarOverrides } from './calendar'
import type { GoogleData } from './data'

/** Longest calendar window an app may ask for in one call. */
const MAX_AGENDA_DAYS = 92

export const GOOGLE_NAMESPACES = ['calendar', 'mail'] as const

export interface GoogleCapabilitiesDeps {
  /** The vault's Google data layer; null when no account is connected to it. */
  dataFor(remote: string): Promise<GoogleData | null>
  /** The calendars the person switched off, which an app does not see either. */
  overrides(): Promise<CalendarOverrides>
}

/** The connected account's data, or the refusal that says there is none. */
async function connected(deps: GoogleCapabilitiesDeps, remote: string): Promise<GoogleData> {
  const data = await deps.dataFor(remote)
  if (data === null) throw new CapabilityError('UNAVAILABLE', 'no Google account connected')
  return data
}

export const googleCapabilities = (deps: GoogleCapabilitiesDeps) => ({
  'calendar.events': cap({
    doors: ['app'],
    appGrant: 'calendar',
    params: (raw) => {
      const p = paramsObject(raw)
      const from = stringParam(p, 'from')
      const to = stringParam(p, 'to')
      const start = Date.parse(from)
      const end = Date.parse(to)
      if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
        throw new CapabilityError('BAD_REQUEST', 'from and to must be instants, from before to')
      }
      if (end - start > MAX_AGENDA_DAYS * 24 * 60 * 60 * 1000) {
        throw new CapabilityError('BAD_REQUEST', `at most ${MAX_AGENDA_DAYS} days at a time`)
      }
      return { timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString() }
    },
    run: async (ctx, window) => {
      const data = await connected(deps, ctx.remote)
      return unavailable(async () => data.agenda(window, await deps.overrides()))
    },
  }),

  'mail.threads': cap({
    doors: ['app'],
    appGrant: 'mail',
    params: (raw) => {
      const p = paramsObject(raw)
      if (p.query !== undefined && typeof p.query !== 'string') {
        throw new CapabilityError('BAD_REQUEST', 'query must be a string')
      }
      return { query: p.query === undefined || p.query === '' ? undefined : p.query }
    },
    run: async (ctx, { query }) => {
      const data = await connected(deps, ctx.remote)
      return (await unavailable(() => data.threads(query === undefined ? {} : { query }))).threads
    },
  }),
})
