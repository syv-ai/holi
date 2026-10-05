/**
 * Google's capabilities (docs/features/google.md): the connection, the
 * calendar and the mail, for every door that reaches them.
 *
 * **The UI door** is the agenda and mail views and the Connections section.
 * **The CLI door** is the agent's `holi google <verb>`: the same verbs it has
 * always had, reached through the core bridge, which already authenticates per
 * vault and names the caller's remote. **The app door** is a vault app's read
 * of the agenda and the mail, each behind its `appGrant`: the app must declare
 * the affordance and the person approve it.
 *
 * Every call resolves the account from the caller's remote, never from the
 * vault on screen: a background agent session outlives a vault switch and must
 * not then reach another vault's mailbox.
 *
 * **`send` and `reply` are the two verbs that reach another person.** Nothing
 * here gates them: the gate is the agent's `PreToolUse` hook
 * (`google-send-gate.mjs`), which matches `holi google send|reply`. The bridge
 * refuses any word before the verb, so that pattern cannot be stepped around.
 * A person pressing Send in the UI has already decided.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import {
  cap,
  CapabilityError,
  flagParam,
  noParams,
  optionalStringParam,
  paramsObject,
  stringParam,
  type CapabilityTable,
} from '../../../main/plugin-api'
import type { GoogleAccountsManager } from './accounts'
import { GoogleApi, GoogleApiError, type GoogleErrorCode } from './api'
import type { CalendarPrefsStore } from './calendar-prefs'
import {
  createEvent,
  deleteEvent,
  resolveCalendars,
  updateEvent,
  type AgendaWindow,
  type EventPatch,
} from './calendar'
import type { ComposeWrite, GoogleData } from './data'
import {
  createDraft,
  fetchCategoryCounts,
  fetchMailCounts,
  listDrafts,
  listSendAs,
  readDraft,
  readThread,
  replyToThread,
  textOnly,
  type MailboxName,
  type MailCategory,
} from './gmail'
import type { ImagePrefsStore } from './image-prefs'
import { resolveThreadMeeting } from './invite'
import type { LoopbackFlow } from './loopback-flow'
import type { OutgoingMail } from './mime'
import { listContacts } from './people'
import { GoogleReconnectRequiredError } from './session'

/** Longest calendar window one call may ask for. */
const MAX_AGENDA_DAYS = 92
const DAY_MS = 24 * 60 * 60 * 1000
/** `agenda` with no window: the next week. */
const DEFAULT_AGENDA_DAYS = 7

export const GOOGLE_NAMESPACES = ['google'] as const

export interface GoogleCapabilityDeps {
  accounts: GoogleAccountsManager
  /** The vault's cached data layer; null when no account is connected to it. */
  dataFor(remote: string): Promise<GoogleData | null>
  /** Which calendars the person switched on: the agenda view, an app and the
   *  agent all read their agenda through it. */
  calendarPrefs: CalendarPrefsStore
  /** Senders whose remote images always load. */
  imagePrefs: ImagePrefsStore
}

const NOT_CONNECTED = 'this vault has no Google account connected'

/**
 * Google's verdict as a refusal each door can render. The code is the point:
 * "reconnect" and "slow down" each have a different thing the person can do.
 * An error Google gave no kind to stays what it was.
 */
async function google<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof GoogleReconnectRequiredError) {
      throw new CapabilityError('UNAUTHORIZED', error.message)
    }
    if (!(error instanceof GoogleApiError) || error.code === 'unknown') throw error
    const codes: Record<Exclude<GoogleErrorCode, 'unknown'>, CapabilityError['code']> = {
      reconnect: 'UNAUTHORIZED',
      scope: 'FORBIDDEN',
      'rate-limit': 'RATE_LIMITED',
      'not-found': 'NOT_FOUND',
    }
    throw new CapabilityError(codes[error.code], error.message)
  }
}

/** An instant, or a refusal naming the param. */
function instant(value: string, key: string): number {
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) throw new CapabilityError('BAD_REQUEST', `${key} must be an instant`)
  return ms
}

/** A calendar window, as instants: `from` defaults to now, `to` to a week
 *  after `from`. Read back with the names the caller sent, so the renderer's
 *  typed client offers the same shape. */
function windowParams(raw: unknown): { from: string; to: string } {
  const p = paramsObject(raw)
  const fromText = optionalStringParam(p, 'from')
  const toText = optionalStringParam(p, 'to')
  const start = fromText === undefined ? Date.now() : instant(fromText, 'from')
  const end = toText === undefined ? start + DEFAULT_AGENDA_DAYS * DAY_MS : instant(toText, 'to')
  if (end <= start) throw new CapabilityError('BAD_REQUEST', 'from must be before to')
  if (end - start > MAX_AGENDA_DAYS * DAY_MS) {
    throw new CapabilityError('BAD_REQUEST', `at most ${MAX_AGENDA_DAYS} days at a time`)
  }
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString() }
}

const agendaWindow = ({ from, to }: { from: string; to: string }): AgendaWindow => ({
  timeMin: from,
  timeMax: to,
})

const MAIL_CATEGORIES: readonly MailCategory[] = [
  'primary',
  'social',
  'promotions',
  'updates',
  'forums',
]

/** A mail search. An unknown category means none, and an unknown mailbox the
 *  inbox: the worst either can do is a list the person can see is wrong. */
function searchParams(raw: unknown): {
  query?: string
  pageToken?: string
  category?: MailCategory
  unread?: boolean
  mailbox?: MailboxName
} {
  const p = paramsObject(raw)
  const category = MAIL_CATEGORIES.find((c) => c === optionalStringParam(p, 'category'))
  const mailbox: MailboxName | undefined =
    optionalStringParam(p, 'mailbox') === 'sent' ? 'sent' : undefined
  const query = optionalStringParam(p, 'query')
  const pageToken = optionalStringParam(p, 'pageToken')
  return {
    ...(query === undefined ? {} : { query }),
    ...(pageToken === undefined ? {} : { pageToken }),
    ...(category === undefined ? {} : { category }),
    ...(flagParam(p, 'unread') ? { unread: true } : {}),
    ...(mailbox === undefined ? {} : { mailbox }),
  }
}

const idParams = (raw: unknown): { id: string } => ({ id: stringParam(paramsObject(raw), 'id') })

/** A JSON boolean the UI sends. */
function booleanParam(p: Record<string, unknown>, key: string): boolean {
  const value = p[key]
  if (typeof value !== 'boolean')
    throw new CapabilityError('BAD_REQUEST', `${key} must be a boolean`)
  return value
}

/** Addresses: the UI sends a list, the CLI one string. */
function addressesParam(p: Record<string, unknown>, key: string): string[] {
  const value = p[key]
  if (value === undefined || value === null || value === '') return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[]
  throw new CapabilityError('BAD_REQUEST', `${key} must be addresses`)
}

/**
 * The composer's payload, checked for **shape** only. The semantic rules stay
 * in `buildRfc822`, the last thing to see the message, which already refuses a
 * newline in any header.
 */
function composeParams(raw: unknown): ComposeWrite {
  const p = paramsObject(raw)
  const draftId = optionalStringParam(p, 'draftId')
  const threadId = optionalStringParam(p, 'threadId')
  const mail = p.mail
  if (mail === null || typeof mail !== 'object' || Array.isArray(mail)) {
    throw new CapabilityError('BAD_REQUEST', 'mail must be an object')
  }
  const m = mail as Record<string, unknown>
  const text = (key: 'subject' | 'body'): string => {
    if (typeof m[key] !== 'string') {
      throw new CapabilityError('BAD_REQUEST', `mail.${key} must be a string`)
    }
    return m[key]
  }
  // Kept even when empty: `buildRfc822` refuses an empty `html` that had body
  // text to render, and dropping it here would send the text unformatted.
  const html = m.html
  if (html !== undefined && html !== null && typeof html !== 'string') {
    throw new CapabilityError('BAD_REQUEST', 'mail.html must be a string')
  }
  const cc = addressesParam(m, 'cc')
  // A forward names the message whose attachments travel with it, never the
  // files: main fetches the bytes, so nothing base64 crosses the IPC seam.
  let forwardOf: { messageId: string } | undefined
  if (p.forwardOf !== undefined && p.forwardOf !== null) {
    if (typeof p.forwardOf !== 'object') {
      throw new CapabilityError('BAD_REQUEST', 'forwardOf must be an object')
    }
    forwardOf = { messageId: stringParam(p.forwardOf as Record<string, unknown>, 'messageId') }
  }
  return {
    ...(draftId === undefined ? {} : { draftId }),
    ...(threadId === undefined ? {} : { threadId }),
    ...(forwardOf === undefined ? {} : { forwardOf }),
    mail: {
      to: addressesParam(m, 'to'),
      ...(cc.length === 0 ? {} : { cc }),
      subject: text('subject'),
      body: text('body'),
      ...(typeof html === 'string' ? { html } : {}),
    },
  }
}

/** The CLI's message: `--to`, `--subject`, `--cc` and the body from stdin. */
function cliMail(p: Record<string, unknown>): OutgoingMail {
  const to = addressesParam(p, 'to')
  if (to.length === 0) throw new CapabilityError('BAD_REQUEST', 'to is required')
  const cc = addressesParam(p, 'cc')
  return {
    to,
    ...(cc.length === 0 ? {} : { cc }),
    subject: stringParam(p, 'subject'),
    body: typeof p.body === 'string' ? p.body : '',
  }
}

/**
 * `send`'s params: the composer's payload from the UI, or the CLI's
 * `--draft <id>` or composed message.
 *
 * `--draft` and a composed message are alternatives, not a merge: a draft
 * already carries its recipients, subject and threading headers, and taking
 * half from each is how a send goes somewhere unintended. A draft goes through
 * Gmail's `drafts.send`, which deletes it as it sends: a draft followed by a
 * composed send would be two messages and an orphaned draft.
 */
function sendParams(raw: unknown): ComposeWrite {
  const p = paramsObject(raw)
  if (p.mail !== undefined) return composeParams(raw)
  const draft = optionalStringParam(p, 'draft')
  if (draft !== undefined) {
    if (p.to !== undefined) {
      throw new CapabilityError('BAD_REQUEST', '--draft and --to are alternatives')
    }
    return { draftId: draft, mail: { to: [], subject: '', body: '' } }
  }
  return { mail: cliMail(p) }
}

/** `schedule`'s and `reschedule`'s event fields. */
function eventFields(p: Record<string, unknown>): EventPatch {
  const title = optionalStringParam(p, 'title')
  const start = optionalStringParam(p, 'start')
  const end = optionalStringParam(p, 'end')
  return {
    ...(title === undefined ? {} : { title }),
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
    ...(flagParam(p, 'all-day') ? { allDay: true } : {}),
  }
}

const ok = { ok: true as const }
const json = (value: unknown): string => JSON.stringify(value, null, 2)

export function googleCapabilities(deps: GoogleCapabilityDeps) {
  /** The connect in progress. One per process: a second supersedes the first
   *  rather than leaving a listener holding a port. */
  let connectFlow: LoopbackFlow | null = null

  /** The vault's data layer, or the refusal that says there is none. */
  const dataOf = async (remote: string): Promise<GoogleData> => {
    const data = await deps.dataFor(remote)
    if (data === null) throw new CapabilityError('UNAVAILABLE', NOT_CONNECTED)
    return data
  }

  /**
   * A Google client bound to the vault's session's token **getter**, never a
   * token. Built per call: a held one would outlive a disconnect.
   */
  const apiOf = (remote: string): GoogleApi =>
    new GoogleApi({
      accessToken: async () => {
        const session = await deps.accounts.sessionFor(remote)
        if (session === null) throw new CapabilityError('UNAVAILABLE', NOT_CONNECTED)
        return session.getAccessToken()
      },
    })

  const overrides = async () => (await deps.calendarPrefs.read()) ?? {}

  return {
    /**
     * Who is connected, and whether that grant is still wide enough. A grant
     * from before `GOOGLE_SCOPES` widened keeps working and is insufficient
     * (mail lists, every write 403s), so the gap is reported, not inferred.
     */
    'google.status': cap({
      doors: ['ui'],
      params: noParams,
      run: async (ctx) => {
        const session = await deps.accounts.sessionFor(ctx.remote).catch(() => null)
        return {
          account: session?.account ?? null,
          missingScopes: session?.missingScopes() ?? [],
        }
      },
    }),

    /** Start the consent in the system browser, linking the account to this
     *  vault once granted. The URL comes back too: some desktops swallow the
     *  launch, and opening it again is the only recovery short of restarting. */
    'google.connect': cap({
      doors: ['ui'],
      params: noParams,
      run: async (ctx) => {
        connectFlow?.cancel()
        connectFlow = await deps.accounts.connect(ctx.remote)
        return { authUrl: connectFlow.authUrl }
      },
    }),

    /** Wait for the consent `connect` started. Long-lived: it settles when
     *  the browser comes back, the person cancels, or the flow times out. The
     *  tokens stop here; the renderer gets an address. */
    'google.awaitConnect': cap({
      doors: ['ui'],
      params: noParams,
      run: async (ctx) => {
        const flow = connectFlow
        if (flow === null) throw new CapabilityError('BAD_REQUEST', 'no Google connect in progress')
        const result = await flow.wait()
        if (connectFlow === flow) connectFlow = null
        if (result.kind !== 'granted') return { kind: result.kind }
        const session = await deps.accounts.sessionFor(ctx.remote)
        if (session === null) throw new CapabilityError('UNAVAILABLE', NOT_CONNECTED)
        return { kind: 'granted' as const, account: session.account }
      },
    }),

    'google.cancelConnect': cap({
      doors: ['ui'],
      params: noParams,
      run: async () => {
        connectFlow?.cancel()
        connectFlow = null
        return ok
      },
    }),

    /** Every account connected on this machine, and the one this vault uses. */
    'google.accounts': cap({
      doors: ['ui'],
      params: noParams,
      run: async (ctx) => ({
        accounts: deps.accounts.list(),
        current: (await deps.accounts.sessionFor(ctx.remote))?.accountSub ?? null,
      }),
    }),

    /** Point this vault at an account already connected. No consent. */
    'google.useAccount': cap({
      doors: ['ui'],
      params: (raw) => ({ sub: stringParam(paramsObject(raw), 'sub') }),
      run: async (ctx, { sub }) => {
        await deps.accounts.link(ctx.remote, sub)
        return ok
      },
    }),

    /** Revoke an account at Google and drop it from every vault using it.
     *  Takes a `sub`, so removing one is always a choice of which. */
    'google.removeAccount': cap({
      doors: ['ui'],
      params: (raw) => ({ sub: stringParam(paramsObject(raw), 'sub') }),
      run: async (_ctx, { sub }) => {
        await deps.accounts.removeAccount(sub)
        return ok
      },
    }),

    /** Unlink this vault. The account and any other vault using it stay. */
    'google.disconnectVault': cap({
      doors: ['ui'],
      params: noParams,
      run: async (ctx) => {
        await deps.accounts.unlinkVault(ctx.remote)
        return ok
      },
    }),

    /**
     * The agenda for a window the **caller** supplies: the machine's local day
     * is the renderer's fact. Always fetched, never served from the cache; a
     * calendar the person switched off is left out for every door.
     */
    'google.agenda': cap({
      doors: ['ui', 'cli', 'app'],
      appGrant: 'calendar',
      cli: {
        args: ['from?', 'to?'],
        summary: 'the agenda, from and to ISO instants (next 7 days)',
      },
      params: windowParams,
      run: async (ctx, window) => {
        const data = await dataOf(ctx.remote)
        return google(async () => data.agenda(agendaWindow(window), await overrides()))
      },
    }),

    /** The last agenda for this exact window and calendar set, or null. Never
     *  a request: the view paints it while `agenda` is in flight. */
    'google.agendaCached': cap({
      doors: ['ui'],
      params: windowParams,
      run: async (ctx, window) =>
        (await deps.dataFor(ctx.remote))?.cachedAgenda(agendaWindow(window), await overrides()) ??
        null,
    }),

    /** Every calendar the account draws from, with its colour and whether it
     *  is on: the agenda's calendar picker. */
    'google.calendars': cap({
      doors: ['ui'],
      params: noParams,
      run: async (ctx) =>
        google(async () => resolveCalendars(apiOf(ctx.remote), await overrides())),
    }),

    /** Switch one calendar on or off, for the agenda view, apps and the agent. */
    'google.setCalendar': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        return { id: stringParam(p, 'id'), enabled: booleanParam(p, 'enabled') }
      },
      run: async (_ctx, { id, enabled }) => {
        await deps.calendarPrefs.set(id, enabled)
        return ok
      },
    }),

    /**
     * A page of threads matching Gmail's own search grammar; no query is the
     * inbox. Cached and current: a `history.list` delta brings the cached list
     * up to date. The CLI prints the threads alone; `nextPageToken` is the
     * list view's "load more".
     */
    'google.search': cap({
      doors: ['ui', 'cli', 'app'],
      appGrant: 'mail',
      cli: { args: ['query?'], summary: "threads matching Gmail's search grammar (the inbox)" },
      params: searchParams,
      run: async (ctx, options) => {
        const data = await dataOf(ctx.remote)
        return google(() => data.threads(options))
      },
      text: (page) => json(page.threads),
    }),

    /**
     * The meeting a thread is about, or null. Asked only for a thread whose
     * summary carries an invite, and never cached: a moved meeting's join link
     * is rewritten, and a stale one sends the person to an empty room.
     */
    'google.meeting': cap({
      doors: ['ui'],
      params: idParams,
      run: async (ctx, { id }) =>
        google(async () =>
          resolveThreadMeeting(apiOf(ctx.remote), id, { overrides: await overrides() }),
        ),
    }),

    /**
     * One thread for the reader. Each message carries `body` (plain text) and
     * `html` (the raw HTML part, or null), **unsanitized**: the renderer
     * sanitizes it, being the process with a DOM, and nothing may render it
     * before that.
     */
    'google.thread': cap({
      doors: ['ui'],
      params: idParams,
      run: async (ctx, { id }) => google(() => readThread(apiOf(ctx.remote), id)),
    }),

    /**
     * One thread for the agent: prose only (`textOnly`). Its own entry rather
     * than `thread`'s text, so `--json` cannot hand the agent the raw markup
     * either: unsanitized HTML reaches exactly one consumer, the renderer.
     */
    'google.read': cap({
      doors: ['cli'],
      cli: { args: ['id'], summary: 'one thread, as text' },
      params: idParams,
      run: async (ctx, { id }) =>
        google(async () => textOnly(await readThread(apiOf(ctx.remote), id))),
    }),

    /**
     * The mailbox writes. Each goes through the vault's data layer, which
     * calls Google first and moves the cached list once Google has agreed, so
     * an agent's archive leaves the list the view paints from at the same
     * moment it leaves Gmail.
     */
    'google.mark-read': cap({
      doors: ['ui', 'cli'],
      cli: { args: ['id'], flags: ['unread'], summary: 'mark a thread read (--unread: unread)' },
      params: (raw) => {
        const p = paramsObject(raw)
        return { id: stringParam(p, 'id'), unread: flagParam(p, 'unread') }
      },
      run: async (ctx, { id, unread }) => {
        const data = await dataOf(ctx.remote)
        await google(() => data.setRead(id, !unread))
        return ok
      },
    }),

    'google.star': cap({
      doors: ['ui', 'cli'],
      cli: { args: ['id'], flags: ['off'], summary: 'star a thread (--off: unstar)' },
      params: (raw) => {
        const p = paramsObject(raw)
        return { id: stringParam(p, 'id'), off: flagParam(p, 'off') }
      },
      run: async (ctx, { id, off }) => {
        const data = await dataOf(ctx.remote)
        await google(() => data.setStarred(id, !off))
        return ok
      },
    }),

    'google.archive': cap({
      doors: ['ui', 'cli'],
      cli: { args: ['id'], summary: 'archive a thread: out of the inbox, still in All Mail' },
      params: idParams,
      run: async (ctx, { id }) => {
        const data = await dataOf(ctx.remote)
        await google(() => data.archive(id))
        return ok
      },
    }),

    /** Trash, which Gmail keeps for 30 days. Not delete: permanent removal
     *  needs `https://mail.google.com/`, which Holi does not request. */
    'google.trash': cap({
      doors: ['ui', 'cli'],
      cli: { args: ['id'], summary: "move a thread to Gmail's trash (recoverable for 30 days)" },
      params: idParams,
      run: async (ctx, { id }) => {
        const data = await dataOf(ctx.remote)
        await google(() => data.trash(id))
        return ok
      },
    }),

    /** The composer's drafts list and one draft's body, straight from Google:
     *  `readDraft` is the one call that answers "is this ours?". */
    'google.drafts': cap({
      doors: ['ui'],
      params: noParams,
      run: async (ctx) => google(() => listDrafts(apiOf(ctx.remote))),
    }),

    'google.draftBody': cap({
      doors: ['ui'],
      params: idParams,
      run: async (ctx, { id }) => google(() => readDraft(apiOf(ctx.remote), id)),
    }),

    /**
     * Every address this account may send from, held per account. Refuses on
     * a missing scope rather than answering an empty list, which would turn
     * every reply-all into one that copies the person on their own message.
     */
    'google.sendAs': cap({
      doors: ['ui'],
      params: noParams,
      run: async (ctx) => {
        const data = await deps.dataFor(ctx.remote)
        return google(() => data?.sendAs() ?? listSendAs(apiOf(ctx.remote)))
      },
    }),

    /** The composer's autosave, through the data layer so a draft appearing
     *  moves the cached thread with it. */
    'google.saveDraft': cap({
      doors: ['ui'],
      params: composeParams,
      run: async (ctx, input) => {
        const data = await dataOf(ctx.remote)
        return google(() => data.saveDraft(input))
      },
    }),

    'google.discardDraft': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        const threadId = optionalStringParam(p, 'threadId')
        return {
          draftId: stringParam(p, 'draftId'),
          ...(threadId === undefined ? {} : { threadId }),
        }
      },
      run: async (ctx, input) => {
        const data = await dataOf(ctx.remote)
        await google(() => data.discardDraft(input))
        return ok
      },
    }),

    /**
     * The agent's draft: the outbound write that reaches nobody, and the one
     * its skill teaches as the default. `--thread` files it in the
     * conversation; without it Gmail makes a loose draft.
     */
    'google.draft': cap({
      doors: ['cli'],
      cli: {
        args: [],
        summary: 'draft a message: --to, --subject, [--cc], [--thread]; the body on stdin',
        stdin: 'body',
      },
      params: (raw) => {
        const p = paramsObject(raw)
        return { mail: cliMail(p), thread: optionalStringParam(p, 'thread') }
      },
      run: async (ctx, { mail, thread }) =>
        google(() => createDraft(apiOf(ctx.remote), mail, thread)),
    }),

    /**
     * Send. From the UI: the composer's payload, where a `draftId` sends that
     * draft, a `threadId` sends into the conversation, and neither a new
     * message. From the CLI: `--draft <id>`, or a composed message with its
     * body on stdin. Reaches another person: the agent's send gate asks first.
     */
    'google.send': cap({
      doors: ['ui', 'cli'],
      cli: {
        args: [],
        summary:
          'send a message (--to, --subject, [--cc]; the body on stdin), or --draft <id>; asks first',
        stdin: 'body',
        stdinUnless: 'draft',
      },
      params: sendParams,
      run: async (ctx, input) => {
        const data = await dataOf(ctx.remote)
        return google(() => data.sendMail(input))
      },
    }),

    /**
     * Reply on a thread, its recipients and subject worked out from the thread
     * (`replyToThread`). The sender only, unless `--all`: the prompt cannot
     * show a derived recipient list, so it must not silently be everyone.
     */
    'google.reply': cap({
      doors: ['cli'],
      cli: {
        args: ['thread'],
        flags: ['all'],
        summary:
          'reply to the sender (--all: everyone on the thread); the body on stdin; asks first',
        stdin: 'body',
      },
      params: (raw) => {
        const p = paramsObject(raw)
        return {
          thread: stringParam(p, 'thread'),
          body: typeof p.body === 'string' ? p.body : '',
          all: flagParam(p, 'all'),
        }
      },
      run: async (ctx, { thread, body, all }) =>
        google(() => replyToThread(apiOf(ctx.remote), thread, body, { all })),
    }),

    /** A solo event. There is no way to invite anyone: inviting would email
     *  them. */
    'google.schedule': cap({
      doors: ['cli'],
      cli: {
        args: [],
        flags: ['all-day'],
        summary: 'add an event: --title, --start, --end, [--location], [--all-day]',
      },
      params: (raw) => {
        const p = paramsObject(raw)
        const location = optionalStringParam(p, 'location')
        return {
          ...eventFields(p),
          ...(location === undefined ? {} : { location }),
          title: stringParam(p, 'title'),
          start: stringParam(p, 'start'),
          end: stringParam(p, 'end'),
        }
      },
      run: async (ctx, event) => google(() => createEvent(apiOf(ctx.remote), event)),
    }),

    /**
     * A solo event the person made by selecting a day in the agenda. The same
     * `createEvent` the agent's `schedule` calls, so it has no `attendees` and
     * mails nobody, on the primary calendar. `end` is exclusive for an all-day
     * event, as Google's is: a single day ends on the day after.
     */
    'google.createEvent': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        const location = optionalStringParam(p, 'location')
        const description = optionalStringParam(p, 'description')
        return {
          title: stringParam(p, 'title'),
          start: stringParam(p, 'start'),
          end: stringParam(p, 'end'),
          ...(flagParam(p, 'allDay') ? { allDay: true } : {}),
          ...(location === undefined || location === '' ? {} : { location }),
          ...(description === undefined || description === '' ? {} : { description }),
        }
      },
      run: async (ctx, event) => google(() => createEvent(apiOf(ctx.remote), event)),
    }),

    /** Move or retitle an event; refused when anyone is invited. */
    'google.reschedule': cap({
      doors: ['cli'],
      cli: {
        args: ['id'],
        flags: ['all-day'],
        summary: 'move or retitle an event: [--start], [--end], [--title]',
      },
      params: (raw) => {
        const p = paramsObject(raw)
        return { id: stringParam(p, 'id'), patch: eventFields(p) }
      },
      run: async (ctx, { id, patch }) => {
        await google(() => updateEvent(apiOf(ctx.remote), id, patch))
        return ok
      },
    }),

    /** Delete an event; refused when anyone is invited, since it would email
     *  them a cancellation. */
    'google.unschedule': cap({
      doors: ['cli'],
      cli: { args: ['id'], summary: 'delete an event nobody else is invited to' },
      params: idParams,
      run: async (ctx, { id }) => {
        await google(() => deleteEvent(apiOf(ctx.remote), id))
        return ok
      },
    }),

    /** How much mail there is, exact, for the list footer; null when the
     *  request fails, so the footer says nothing rather than guess. */
    'google.mailCounts': cap({
      doors: ['ui'],
      params: noParams,
      run: async (ctx) => fetchMailCounts(apiOf(ctx.remote)),
    }),

    /** The address book for `@`-completion, held per account. Never fails:
     *  completion falls back to the senders in loaded threads. */
    'google.contacts': cap({
      doors: ['ui'],
      params: noParams,
      run: async (ctx) =>
        (await deps.dataFor(ctx.remote))?.contacts() ?? listContacts(apiOf(ctx.remote)),
    }),

    /** Unread per Gmail tab, for the category picker: five requests, only
     *  when the picker opens. */
    'google.categoryCounts': cap({
      doors: ['ui'],
      params: noParams,
      run: async (ctx) => google(() => fetchCategoryCounts(apiOf(ctx.remote))),
    }),

    /** The senders whose remote images always load. Kept per machine and
     *  account, never in a vault: a vault is a shared repo. */
    'google.imageSenders': cap({
      doors: ['ui'],
      params: noParams,
      run: async () => deps.imagePrefs.read(),
    }),

    'google.allowImagesFrom': cap({
      doors: ['ui'],
      params: (raw) => ({ sender: stringParam(paramsObject(raw), 'sender') }),
      run: async (_ctx, { sender }) => {
        await deps.imagePrefs.allow(sender)
        return ok
      },
    }),

    'google.forgetImageSenders': cap({
      doors: ['ui'],
      params: noParams,
      run: async () => {
        await deps.imagePrefs.clear()
        return ok
      },
    }),
  } satisfies CapabilityTable
}

export type GoogleCapabilities = ReturnType<typeof googleCapabilities>
