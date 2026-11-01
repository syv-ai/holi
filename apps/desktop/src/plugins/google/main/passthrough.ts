/**
 * `holi google api <METHOD> <path>`: the rest of Gmail and Calendar, for what
 * the named verbs do not cover (docs/features/google.md).
 *
 * **Main decides what a call is**, from the method, the path and the body, and
 * never from anything the agent says about it. One table (`RULES`) sorts every
 * call into a tier:
 *
 * - `read`: a `GET`, or Calendar's `freeBusy`, which is a query sent as a POST.
 * - `write`: undoable and reaching nobody: a label change, trash and untrash,
 *   a draft, a solo event. Calendar writes in this tier carry
 *   `sendUpdates=none` whatever the call said, so a write judged silent stays so.
 * - `reaches-others`: sending mail, any event change Holi cannot see the
 *   guests of, `sendUpdates` other than `none`, and **anything mutating the
 *   table does not know**.
 * - blocked: every permanent delete, refused here whatever the person answers.
 *
 * The send gate sees only the command line, not the body on stdin, so it asks
 * for every call that is not a `GET`: a superset of `reaches-others`. Main's
 * part is the floor beneath it: the blocked tier, the two APIs and nothing
 * else, and no path that could leave them.
 *
 * The path is relative to Google's API root, `gmail/v1/users/me/...` or
 * `calendar/v3/...`; Holi supplies the host. A host, a scheme, `..`, an empty
 * segment or an encoded dot or slash is refused, as is another user's mailbox.
 */
import { fenceUntrusted, type UntrustedSource } from '@holi/shared'
import { CapabilityError } from '../../../main/plugin-api'

type ApiCallKind = 'read' | 'write' | 'reaches-others'

type Service = 'gmail' | 'calendar'

/** Each API: the path it starts with, the host serving it, and what its text is. */
const SERVICES: Record<Service, { prefix: string; origin: string; source: UntrustedSource }> = {
  gmail: { prefix: 'gmail/v1/users/me', origin: 'https://gmail.googleapis.com', source: 'mail' },
  calendar: { prefix: 'calendar/v3', origin: 'https://www.googleapis.com', source: 'calendar' },
}

/** One call, as a rule sees it. `path` is what follows the service's prefix. */
interface ApiRequest {
  service: Service
  method: string
  path: string
  query: URLSearchParams
  body: unknown
}

type Verdict = ApiCallKind | { blocked: string }

interface Rule {
  service: Service
  methods: readonly string[]
  path: RegExp
  verdict: Verdict | ((call: ApiRequest) => Verdict)
}

const ID = '[^/]+'
const path = (pattern: string): RegExp => new RegExp(`^${pattern}$`)

const TRASH_INSTEAD = 'trash it instead, which Gmail keeps for 30 days'

/** Does this calendar write tell anyone? Guests in the body, or a request to
 *  notify them. Without either, Google mails nobody. */
function calendarAudience(call: ApiRequest): ApiCallKind {
  const updates = call.query.get('sendUpdates')
  if (updates !== null && updates !== 'none') return 'reaches-others'
  if (call.query.get('sendNotifications') === 'true') return 'reaches-others'
  const attendees =
    call.body !== null && typeof call.body === 'object'
      ? (call.body as { attendees?: unknown }).attendees
      : undefined
  return Array.isArray(attendees) && attendees.length > 0 ? 'reaches-others' : 'write'
}

/**
 * The table, first match wins. A `GET` is a read before any rule is asked; a
 * mutating call no rule names is `reaches-others`.
 */
const RULES: readonly Rule[] = [
  // Gmail: every delete it has is permanent (a message, a thread, a draft, a
  // label), and none of them goes through the bin.
  {
    service: 'gmail',
    methods: ['DELETE'],
    path: /.*/,
    verdict: { blocked: `Gmail deletes permanently; ${TRASH_INSTEAD}` },
  },
  {
    service: 'gmail',
    methods: ['POST'],
    path: path('/messages/batchDelete'),
    verdict: { blocked: `Gmail deletes permanently; ${TRASH_INSTEAD}` },
  },
  {
    service: 'gmail',
    methods: ['POST'],
    path: path('/(messages|drafts)/send'),
    verdict: 'reaches-others',
  },
  {
    service: 'gmail',
    methods: ['POST'],
    path: path(`/(messages|threads)/${ID}/(modify|trash|untrash)`),
    verdict: 'write',
  },
  {
    service: 'gmail',
    methods: ['POST'],
    path: path('/messages(/batchModify|/import)?'),
    verdict: 'write',
  },
  { service: 'gmail', methods: ['POST'], path: path('/drafts'), verdict: 'write' },
  { service: 'gmail', methods: ['PUT'], path: path(`/drafts/${ID}`), verdict: 'write' },
  { service: 'gmail', methods: ['POST'], path: path('/labels'), verdict: 'write' },
  { service: 'gmail', methods: ['PUT', 'PATCH'], path: path(`/labels/${ID}`), verdict: 'write' },

  // Calendar keeps a deleted event in its bin, so deleting one is not
  // permanent; it may still cancel it for every guest.
  {
    service: 'calendar',
    methods: ['DELETE'],
    path: path(`/calendars/${ID}/events/${ID}`),
    verdict: 'reaches-others',
  },
  {
    service: 'calendar',
    methods: ['DELETE'],
    path: /.*/,
    verdict: { blocked: 'this deletes permanently; ask the user to do it in Google Calendar' },
  },
  {
    service: 'calendar',
    methods: ['POST'],
    path: path(`/calendars/${ID}/clear`),
    verdict: { blocked: 'this deletes every event permanently' },
  },
  { service: 'calendar', methods: ['POST'], path: path('/freeBusy'), verdict: 'read' },
  // A new event, or an imported one, reaches nobody unless it names guests or
  // asks Google to notify. A change to an existing one is `reaches-others` by
  // the fallback: its guests are on the event, not in the call.
  {
    service: 'calendar',
    methods: ['POST'],
    path: path(`/calendars/${ID}/events(/import)?`),
    verdict: calendarAudience,
  },
]

/** A judged call, ready to send. `source` names whose text its answer is. */
export interface ApiCall {
  kind: ApiCallKind
  method: string
  url: string
  body?: unknown
  source: UntrustedSource
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

/** The path, checked, split into its service, the rest and the query. */
function resolvePath(raw: string): { service: Service; rest: string; query: string } {
  const bad = (why: string) =>
    new CapabilityError(
      'BAD_REQUEST',
      `${why}: give a path under gmail/v1/users/me/ or calendar/v3/, without a host`,
    )
  // Whitespace, control characters, a backslash or a fragment have no place
  // in an API path, and each is a way URL parsing could read it differently.
  if (/[\s\\#]/.test(raw) || /\p{Cc}/u.test(raw)) throw bad('not an API path')
  const relative = raw.startsWith('/') ? raw.slice(1) : raw
  if (/^[a-z][a-z0-9+.-]*:/i.test(relative) || relative.startsWith('/')) {
    throw bad('a URL is not allowed')
  }
  const at = relative.indexOf('?')
  const pathPart = at < 0 ? relative : relative.slice(0, at)
  const query = at < 0 ? '' : relative.slice(at + 1)
  if (/%(2e|2f|5c|00)/i.test(pathPart)) throw bad('an encoded dot or slash is not allowed')
  if (pathPart.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw bad('an empty, . or .. segment is not allowed')
  }
  for (const service of ['gmail', 'calendar'] as const) {
    const { prefix } = SERVICES[service]
    if (pathPart === prefix || pathPart.startsWith(`${prefix}/`)) {
      return { service, rest: pathPart.slice(prefix.length), query }
    }
  }
  if (pathPart.startsWith('gmail/v1/users/')) throw bad("only the user's own mailbox, users/me")
  throw bad('not a Gmail or Calendar path')
}

/** The body the agent sent: JSON, or nothing. */
function parseBody(text: string | undefined): unknown {
  if (text === undefined || text.trim() === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new CapabilityError('BAD_REQUEST', 'the body must be JSON')
  }
}

/**
 * Judge a call and build the request it becomes, or refuse it. Pure: the tier
 * comes from the method, the path and the body alone.
 */
export function planApiCall(methodText: string, rawPath: string, bodyText?: string): ApiCall {
  const method = methodText.toUpperCase()
  if (!METHODS.includes(method)) {
    throw new CapabilityError('BAD_REQUEST', `the method is one of ${METHODS.join(', ')}`)
  }
  const { service, rest, query } = resolvePath(rawPath)
  const body = parseBody(bodyText)
  if (method === 'GET' && body !== undefined) {
    throw new CapabilityError('BAD_REQUEST', 'a GET takes no body')
  }
  const { prefix, origin, source } = SERVICES[service]
  const params = new URLSearchParams(query)
  const request: ApiRequest = { service, method, path: rest, query: params, body }

  let verdict: Verdict = 'read'
  if (method !== 'GET') {
    const rule = RULES.find(
      (r) => r.service === service && r.methods.includes(method) && r.path.test(rest),
    )
    const found = rule === undefined ? 'reaches-others' : rule.verdict
    verdict = typeof found === 'function' ? found(request) : found
  }
  if (typeof verdict === 'object') {
    throw new CapabilityError('FORBIDDEN', `Holi never lets the agent do this: ${verdict.blocked}`)
  }
  // A calendar write judged silent is made silent, whatever the call said.
  if (verdict === 'write' && service === 'calendar') params.set('sendUpdates', 'none')

  const url = new URL(`${origin}/${prefix}${rest}`)
  // Belt and braces: whatever URL parsing made of the path, it is still the
  // path that was judged, on Google's host.
  if (url.origin !== origin || url.pathname !== `/${prefix}${rest}`) {
    throw new CapabilityError('BAD_REQUEST', 'not an API path')
  }
  url.search = params.toString()
  return {
    kind: verdict,
    method,
    url: url.toString(),
    source,
    ...(body === undefined ? {} : { body }),
  }
}

/**
 * Fields that are ids, addresses, dates, links or Google's own enums: what the
 * agent passes back to a command, never prose. Every other string in an answer
 * is fenced, since a raw answer's free text is somebody else's (a header, a
 * snippet, a title, a base64 body); a field this list does not know is fenced
 * too, so a new one errs towards the label.
 */
const PLAIN = new Set([
  'id',
  'threadId',
  'historyId',
  'labelIds',
  'etag',
  'kind',
  'nextPageToken',
  'nextSyncToken',
  'resultSizeEstimate',
  'sizeEstimate',
  'internalDate',
  'mimeType',
  'partId',
  'attachmentId',
  'email',
  'emailAddress',
  'dateTime',
  'date',
  'timeZone',
  'created',
  'updated',
  'htmlLink',
  'hangoutLink',
  'iCalUID',
  'recurringEventId',
  'status',
  'responseStatus',
  'eventType',
  'transparency',
  'visibility',
  'colorId',
  'type',
  'accessRole',
  'calendarId',
  'uri',
])

/** `value` with every string not under a `PLAIN` key fenced as `source`. */
export function fenceAnswer(value: unknown, source: UntrustedSource, key?: string): unknown {
  if (typeof value === 'string') {
    return key !== undefined && PLAIN.has(key) ? value : fenceUntrusted(value, source)
  }
  if (Array.isArray(value)) return value.map((item) => fenceAnswer(item, source, key))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fenceAnswer(v, source, k)]))
  }
  return value
}
