/**
 * Mail attention is account-owned, not view-owned.
 *
 * One account/session poll is shared by every vault activation that uses it.
 * The unread snapshot is always maintained; the machine-local notification
 * preference only decides whether one eligible vault raises the aggregate
 * native banner. A separate Gmail history cursor observes genuine message
 * delivery without borrowing the mail list cache or its automation polling.
 */
import type { Notice } from '../../../main/plugin-api'
import { MAIL_ATTENTION_EVENT, OPEN_MAIL_EVENT, type MailAttentionSnapshot } from '../shared/types'
import { GoogleApiError, type GoogleApi } from './api'
import { fetchMailCounts } from './gmail'
import { mapPooled } from './map-pooled'

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'
const HISTORY_URL = `${BASE}/history`
const PROFILE_URL = `${BASE}/profile`
const POLL_MS = 60_000
const HISTORY_PAGE_CAP = 5
const HISTORY_PAGE_SIZE = '100'
const MESSAGE_CAP = 100
const MESSAGE_CONCURRENCY = 6
const SEEN_CAP = 1_000

export { MAIL_ATTENTION_EVENT }

/** The identity/lifetime facts the module needs from a connected grant. */
export interface MailAttentionSession {
  accountSub: string | null
}

interface MailAttentionSubscription {
  remote: string
  /** Read fresh after network work, so a preference change cannot race a banner. */
  notifications(): Promise<boolean>
  /** A full snapshot, suitable for a revision-aware renderer store. */
  changed(snapshot: MailAttentionSnapshot): void
  /** The activation-bound native notification adapter (`PluginCtx.notify`). */
  notify(notice: Notice): boolean
  /** Stops publication synchronously when the activation is revoked. */
  signal?: AbortSignal
}

interface MailAttentionLease {
  snapshot(): MailAttentionSnapshot
  stop(): Promise<void>
}

/**
 * The module's small interface. `subscribe` owns one vault activation;
 * `refresh` re-resolves every vault/account mapping and polls each account once.
 */
export interface MailAttention {
  subscribe(subscription: MailAttentionSubscription): Promise<MailAttentionLease>
  refresh(options?: { drain?: boolean }): Promise<void>
}

export interface MailAttentionDeps<S extends MailAttentionSession> {
  sessionFor(remote: string): Promise<S | null>
  grantFor(session: S): object
  apiFor(session: S): GoogleApi
  now?: () => Date
  pollMs?: number
  schedule?: (poll: () => void, everyMs: number) => () => void
  log?: (message: string) => void
}

interface Subscriber<S extends MailAttentionSession> extends MailAttentionSubscription {
  active: boolean
  session: S | null
  state: AccountState<S> | null
  snapshotValue: MailAttentionSnapshot
  removeAbort: (() => void) | null
  stopping: Promise<void> | null
}

interface AccountState<S extends MailAttentionSession> {
  grant: object
  sub: string
  subscribers: Set<Subscriber<S>>
  cursor: string | null
  seenMessageIds: Set<string>
  stopTimer: () => void
  retired: boolean
  polling: Promise<void> | null
}

interface RawHistoryMessage {
  id?: string
}

interface RawHistoryRecord {
  id?: string
  messagesAdded?: { message?: RawHistoryMessage }[]
}

interface RawHistoryPage {
  history?: RawHistoryRecord[]
  historyId?: string
  nextPageToken?: string
}

interface RawMessage {
  id?: string
  labelIds?: string[]
}

type HistoryResult =
  | { kind: 'arrivals'; cursor: string; messageIds: string[] }
  | { kind: 'recover'; cursor: string | null }

export function createMailAttention<S extends MailAttentionSession>(
  deps: MailAttentionDeps<S>,
): MailAttention {
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? ((message: string) => console.warn(`[google mail attention] ${message}`))
  const schedule =
    deps.schedule ??
    ((poll: () => void, everyMs: number) => {
      const timer = setInterval(poll, everyMs)
      return () => clearInterval(timer)
    })
  const subscribers = new Set<Subscriber<S>>()
  const accounts = new Map<object, AccountState<S>>()
  let refreshing: Promise<void> = Promise.resolve()

  const publicInterface: MailAttention = {
    async subscribe(input) {
      const subscriber: Subscriber<S> = {
        ...input,
        active: input.signal?.aborted !== true,
        session: null,
        state: null,
        snapshotValue: disconnectedSnapshot(),
        removeAbort: null,
        stopping: null,
      }
      subscribers.add(subscriber)
      if (input.signal !== undefined) {
        const stop = () => void stopSubscriber(subscriber)
        input.signal.addEventListener('abort', stop, { once: true })
        subscriber.removeAbort = () => input.signal?.removeEventListener('abort', stop)
      }
      await reconcileSubscriber(subscriber, true)
      // Activation owns this poll, but vault opening does not wait on Gmail.
      if (subscriber.state !== null) void pollAccount(subscriber.state)
      return {
        snapshot: () => ({ ...subscriber.snapshotValue }),
        stop: () => stopSubscriber(subscriber),
      }
    },

    refresh: (options) => refreshAll(true, options?.drain !== false),
  }

  return publicInterface

  function refreshAll(poll: boolean, drain = true): Promise<void> {
    const run = refreshing.then(async () => {
      await Promise.all(
        [...subscribers].map((subscriber) => reconcileSubscriber(subscriber, drain)),
      )
      if (poll) await Promise.all([...accounts.values()].map(pollAccount))
    })
    refreshing = run.catch(() => undefined)
    return run
  }

  async function reconcileSubscriber(subscriber: Subscriber<S>, drain: boolean): Promise<void> {
    if (!isLive(subscriber)) {
      await detach(subscriber, drain)
      return
    }
    let session: S | null
    try {
      session = await deps.sessionFor(subscriber.remote)
    } catch (error) {
      log(`resolve ${subscriber.remote}: ${String(error)}`)
      publishUncertain(subscriber)
      return
    }
    if (!isLive(subscriber)) {
      await detach(subscriber, drain)
      return
    }
    const sub = session?.accountSub ?? null
    if (session === null || sub === null) {
      await detach(subscriber, drain)
      publish(subscriber, disconnectedSnapshot())
      return
    }
    if (subscriber.session !== session) {
      await detach(subscriber, drain)
      attach(subscriber, session, sub)
    }
  }

  function attach(subscriber: Subscriber<S>, session: S, sub: string): void {
    const grant = deps.grantFor(session)
    let state = accounts.get(grant)
    if (state === undefined) {
      state = {
        grant,
        sub,
        subscribers: new Set(),
        cursor: null,
        seenMessageIds: new Set(),
        stopTimer: () => {},
        retired: false,
        polling: null,
      }
      state.stopTimer = schedule(
        () => void pollAccount(state!).catch((error) => log(`poll ${sub}: ${String(error)}`)),
        deps.pollMs ?? POLL_MS,
      )
      accounts.set(grant, state)
    }
    subscriber.session = session
    subscriber.state = state
    state.subscribers.add(subscriber)
    publish(subscriber, {
      accountSub: sub,
      unreadThreads: null,
      status: 'unknown',
      revision: 0,
      updatedAt: null,
    })
  }

  async function detach(subscriber: Subscriber<S>, drain = true): Promise<void> {
    const state = subscriber.state
    subscriber.session = null
    subscriber.state = null
    if (state === null) return
    state.subscribers.delete(subscriber)
    if (state.subscribers.size > 0 || state.retired) return
    state.retired = true
    state.stopTimer()
    accounts.delete(state.grant)
    if (drain) await state.polling
  }

  function stopSubscriber(subscriber: Subscriber<S>): Promise<void> {
    if (subscriber.stopping !== null) return subscriber.stopping
    subscriber.active = false
    subscribers.delete(subscriber)
    subscriber.removeAbort?.()
    subscriber.removeAbort = null
    subscriber.stopping = detach(subscriber)
    return subscriber.stopping
  }

  function pollAccount(state: AccountState<S>): Promise<void> {
    if (state.retired || state.subscribers.size === 0) return Promise.resolve()
    if (state.polling !== null) return state.polling
    const pending = runPoll(state)
      .catch((error) => log(`poll ${state.sub}: ${String(error)}`))
      .finally(() => {
        if (state.polling === pending) state.polling = null
      })
    state.polling = pending
    return pending
  }

  async function runPoll(state: AccountState<S>): Promise<void> {
    const authorized = [...state.subscribers].find(isLive)
    if (authorized === undefined) return
    const api = deps.apiFor(authorized.session!)
    const counts = fetchMailCounts(api)
    const history =
      state.cursor === null
        ? currentHistoryId(api).then((cursor) => ({ kind: 'recover', cursor }) as const)
        : historySince(api, state.cursor)
    const [countResult, historyResult] = await Promise.allSettled([counts, history])

    let current = await revalidate(state)
    if (state.retired || current.size === 0) return

    if (countResult.status === 'fulfilled' && countResult.value !== null) {
      const stamp = now().toISOString()
      for (const subscriber of current) {
        publish(subscriber, {
          accountSub: subscriber.session!.accountSub,
          unreadThreads: countResult.value.unread,
          status: 'fresh',
          revision: 0,
          updatedAt: stamp,
        })
      }
    } else {
      for (const subscriber of current) {
        const before = subscriber.snapshotValue
        publish(subscriber, {
          ...before,
          accountSub: subscriber.session!.accountSub,
          status: before.unreadThreads === null ? 'unknown' : 'stale',
          revision: 0,
        })
      }
    }

    if (historyResult.status === 'rejected') return
    const result = historyResult.value
    if (result.kind === 'recover') {
      state.cursor = result.cursor
      return
    }
    state.cursor = result.cursor
    const arrivals = result.messageIds.filter((id) => !state.seenMessageIds.has(id))
    remember(state.seenMessageIds, result.messageIds)
    if (arrivals.length === 0) return

    current = await revalidate(state)
    if (state.retired || current.size === 0) return
    for (const subscriber of [...current].sort((a, b) => a.remote.localeCompare(b.remote))) {
      if (!isLive(subscriber) || subscriber.state !== state) continue
      let enabled = false
      try {
        enabled = await subscriber.notifications()
      } catch (error) {
        log(`preference ${subscriber.remote}: ${String(error)}`)
      }
      if (!isLive(subscriber) || subscriber.state !== state || !enabled) continue
      subscriber.notify({
        title: 'New mail',
        body:
          arrivals.length === 1
            ? '1 unread message arrived.'
            : `${arrivals.length} unread messages arrived.`,
        navigate: { name: OPEN_MAIL_EVENT, payload: { mailbox: 'inbox' } },
      })
      break
    }
  }

  async function revalidate(state: AccountState<S>): Promise<Set<Subscriber<S>>> {
    const currentSubscribers = new Set<Subscriber<S>>()
    for (const subscriber of [...state.subscribers]) {
      if (!isLive(subscriber)) {
        await detach(subscriber, false)
        continue
      }
      let current: S | null
      try {
        current = await deps.sessionFor(subscriber.remote)
      } catch {
        // An uncertain mapping cannot authorize publication or a banner, but it
        // also is not proof that the account was disconnected.
        publishUncertain(subscriber)
        continue
      }
      if (!isLive(subscriber)) {
        await detach(subscriber, false)
        continue
      }
      if (
        current !== null &&
        current === subscriber.session &&
        deps.grantFor(current) === state.grant
      ) {
        currentSubscribers.add(subscriber)
        continue
      }
      await detach(subscriber, false)
      const sub = current?.accountSub ?? null
      if (current !== null && sub !== null) attach(subscriber, current, sub)
      else publish(subscriber, disconnectedSnapshot())
    }
    return currentSubscribers
  }

  function publishUncertain(subscriber: Subscriber<S>): void {
    const before = subscriber.snapshotValue
    publish(subscriber, {
      ...before,
      status: before.unreadThreads === null ? 'unknown' : 'stale',
      revision: 0,
    })
  }

  function publish(subscriber: Subscriber<S>, next: MailAttentionSnapshot): void {
    if (!isLive(subscriber)) return
    const before = subscriber.snapshotValue
    const candidate = {
      ...next,
      revision: before.revision,
    }
    if (sameSnapshot(before, candidate)) return
    const snapshot = { ...candidate, revision: before.revision + 1 }
    subscriber.snapshotValue = snapshot
    subscriber.changed({ ...snapshot })
  }
}

async function currentHistoryId(api: GoogleApi): Promise<string | null> {
  const profile = await api.get<{ historyId?: string }>(PROFILE_URL)
  return profile.historyId ?? null
}

async function historySince(api: GoogleApi, cursor: string): Promise<HistoryResult> {
  const ids = new Set<string>()
  let pageToken: string | undefined
  let latest: string | null = null
  try {
    for (let pageNumber = 0; pageNumber < HISTORY_PAGE_CAP; pageNumber += 1) {
      const page = await api.get<RawHistoryPage>(HISTORY_URL, {
        startHistoryId: cursor,
        historyTypes: 'messageAdded',
        labelId: 'INBOX',
        maxResults: HISTORY_PAGE_SIZE,
        pageToken,
      })
      latest = page.historyId ?? latest
      const historyIds = new Set<string>()
      for (const record of page.history ?? []) {
        if (record.id !== undefined && historyIds.has(record.id)) continue
        if (record.id !== undefined) historyIds.add(record.id)
        for (const added of record.messagesAdded ?? []) {
          const id = added.message?.id
          if (id !== undefined) ids.add(id)
          if (ids.size > MESSAGE_CAP) return { kind: 'recover', cursor: await safeHistoryId(api) }
        }
      }
      if (page.nextPageToken === undefined) {
        if (latest === null) return { kind: 'recover', cursor: await safeHistoryId(api) }
        const messages = await mapPooled([...ids], MESSAGE_CONCURRENCY, (id) =>
          api.get<RawMessage>(`${BASE}/messages/${encodeURIComponent(id)}`, {
            format: 'metadata',
            fields: 'id,labelIds',
          }),
        )
        const delivered = messages.flatMap((message, index) => {
          const labels = new Set(message.labelIds ?? [])
          return labels.has('INBOX') && labels.has('UNREAD') ? [message.id ?? [...ids][index]!] : []
        })
        return { kind: 'arrivals', cursor: latest, messageIds: [...new Set(delivered)] }
      }
      pageToken = page.nextPageToken
    }
    return { kind: 'recover', cursor: await safeHistoryId(api) }
  } catch (error) {
    if (error instanceof GoogleApiError && error.status === 404) {
      return { kind: 'recover', cursor: await safeHistoryId(api) }
    }
    throw error
  }
}

async function safeHistoryId(api: GoogleApi): Promise<string | null> {
  try {
    return await currentHistoryId(api)
  } catch {
    return null
  }
}

function remember(seen: Set<string>, ids: readonly string[]): void {
  for (const id of ids) seen.add(id)
  while (seen.size > SEEN_CAP) seen.delete(seen.values().next().value as string)
}

function disconnectedSnapshot(): MailAttentionSnapshot {
  return {
    accountSub: null,
    unreadThreads: null,
    status: 'disconnected',
    revision: 0,
    updatedAt: null,
  }
}

function sameSnapshot(left: MailAttentionSnapshot, right: MailAttentionSnapshot): boolean {
  return (
    left.accountSub === right.accountSub &&
    left.unreadThreads === right.unreadThreads &&
    left.status === right.status &&
    left.updatedAt === right.updatedAt
  )
}

function isLive<S extends MailAttentionSession>(subscriber: Subscriber<S>): boolean {
  return subscriber.active && subscriber.signal?.aborted !== true
}
