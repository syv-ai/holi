/**
 * Google's capabilities: a vault app's read of the connected calendar and
 * mail. The app door only: the agent has `holi-google`, and its own gate.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import type { AppAffordance } from '@holi/shared'
import type { AppGrants } from '../apps/app-grants'
import { CapabilityError, unavailable } from '../capabilities/error'
import { paramsObject, stringParam } from '../capabilities/params'
import { cap, type CapabilityContext } from '../capabilities/registry'
import type { CalendarOverrides } from './calendar'
import type { GoogleData } from './data'

/** Longest calendar window an app may ask for in one call. */
const MAX_AGENDA_DAYS = 92

/**
 * The gate on a read of one person's Google data: the app must declare the
 * affordance in `dangerously-allow`, and the person must have approved it on
 * this machine (`apps/app-grants.ts`). Only the app door reaches these entries.
 */
async function requireGrant(
  grants: AppGrants,
  ctx: CapabilityContext,
  affordance: AppAffordance,
): Promise<void> {
  const bundle = ctx.bundle
  if (bundle === null) throw new CapabilityError('BAD_REQUEST', 'only an app may ask')
  const status = (await grants.status(ctx.remote, ctx.root, bundle)).affordances.find(
    (s) => s.affordance === affordance,
  )
  if (status === undefined) {
    throw new CapabilityError(
      'FORBIDDEN',
      `add "dangerously-allow: [${affordance}]" to ${bundle}/app.yaml to read ${affordance}`,
    )
  }
  if (!status.granted) {
    throw new CapabilityError('FORBIDDEN', `reading ${affordance} is not approved on this machine`)
  }
}

export const GOOGLE_NAMESPACES = ['calendar', 'mail'] as const

export interface GoogleCapabilitiesDeps {
  /** The vault's Google data layer; null when no account is connected to it. */
  dataFor(remote: string): Promise<GoogleData | null>
  /** The calendars the person switched off, which an app does not see either. */
  overrides(): Promise<CalendarOverrides>
  grants: AppGrants
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
      await requireGrant(deps.grants, ctx, 'calendar')
      const data = await connected(deps, ctx.remote)
      return unavailable(async () => data.agenda(window, await deps.overrides()))
    },
  }),

  'mail.threads': cap({
    doors: ['app'],
    params: (raw) => {
      const p = paramsObject(raw)
      if (p.query !== undefined && typeof p.query !== 'string') {
        throw new CapabilityError('BAD_REQUEST', 'query must be a string')
      }
      return { query: p.query === undefined || p.query === '' ? undefined : p.query }
    },
    run: async (ctx, { query }) => {
      await requireGrant(deps.grants, ctx, 'mail')
      const data = await connected(deps, ctx.remote)
      return (await unavailable(() => data.threads(query === undefined ? {} : { query }))).threads
    },
  }),
})
