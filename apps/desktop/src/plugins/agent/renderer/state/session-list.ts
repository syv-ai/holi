/**
 * The Agents sidebar's one session list (docs/features/agent-sessions.md, The
 * Agents view): the rows every plugin adds through its slot (a Holi's
 * runs, an automation's runs) and the agent's own live sessions, merged by job
 * id, with the state each row shows, the filter, and the groups.
 *
 * The sidebar's Sessions are the open rows, as tabs are open documents: one
 * the person started stays open until they close it, which stops what it runs.
 * Every row, open or closed, is in History.
 *
 * The states are after MonoCode's session cards (MIT, Copyright (c) 2026
 * Nick; see NOTICE.md): working while a turn is in flight, needs you while a
 * permission prompt or a question waits, and done from the moment a turn ends
 * until the row is opened ("Sessions that finished while unfocused, until the
 * user looks at them", MonoCode's `sessionDone.ts`).
 */
import { atom } from 'jotai'
import { HistoryIcon } from 'lucide-react'
import { atomWithStorage } from 'jotai/utils'
import {
  agentsSelectionAtom,
  appModeAtom,
  agentsSlotsAtom,
  type AgentsSessionItem,
  type AgentsTabLook,
  type AgentsSessionsSource,
  type PluginStore,
} from '@/plugin-api'
import { agentsViewAtom, agentsViewOf } from './agents-view'
import { stopSessionAtom } from './send'
import { showSessionAtom, startViewSessionAtom } from './session-view'
import { NEW_SESSION, agentHistoryAtom, agentSessionsAtom, type AgentSession } from './sessions'

export type { AgentsSessionItem }

/** What a row shows: the three states worth noticing, or nothing (read). */
export type SessionRowState = 'needs-you' | 'working' | 'done' | 'idle'

/** A row as the list draws it: the item, its state, and whether it is open. */
export interface SessionRow {
  item: AgentsSessionItem
  state: SessionRowState
  current: boolean
}

// ------------------------------------------------------------------ pure

/** `claude-opus-5-5` or `opus` as a person says it: `Opus 5.5`, `Opus`. */
export function modelLabel(model: string | undefined, agent?: AgentsSessionItem['agent']): string {
  if (model === undefined || model.trim() === '')
    return agent === 'pi' ? 'Pi' : agent === 'codex' ? 'Codex' : 'Claude'
  const m = /^(?:claude-)?(opus|sonnet|haiku)(?:-(\d+)(?:-(\d{1,2}))?)?(?:-\d{8})?(\[1m\])?$/i.exec(
    model.trim(),
  )
  if (m === null) return model
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase()
  const version = m[2] === undefined ? '' : ` ${m[2]}${m[3] === undefined ? '' : `.${m[3]}`}`
  return `${family}${version}`
}

/** The agent's own live session as a row. */
function liveItem(s: AgentSession): AgentsSessionItem {
  return {
    key: `agent:${s.id}`,
    jobId: s.id,
    title: s.name,
    state: s.state,
    agent: s.provider,
    updatedAt: s.startedAt ?? 0,
    ...(s.model === undefined ? {} : { model: s.model }),
    ...(s.waitingFor === undefined ? {} : { waitingFor: s.waitingFor }),
  }
}

/**
 * Every plugin's rows and the live sessions as one list: a live session that
 * is a plugin's run (same job id) is that run's row, with the session's
 * state, model and name; the rest are rows of their own. A slot's row comes
 * first among those that share a job id, so a Holi's run wins over an
 * automation's for the same session. Then the stopped background sessions
 * (`past`) no plugin ran, idle: your own earlier conversations, which
 * opening brings back.
 * @public exported for its test
 */
export function mergeSessionItems(
  slotItems: readonly AgentsSessionItem[],
  live: readonly AgentSession[],
  past: readonly AgentSession[] = [],
): AgentsSessionItem[] {
  const byJob = new Map(live.map((s) => [s.id, s]))
  const out: AgentsSessionItem[] = []
  const taken = new Set<string>()
  for (const item of slotItems) {
    if (item.jobId !== undefined) {
      if (taken.has(item.jobId)) continue
      taken.add(item.jobId)
      const s = byJob.get(item.jobId)
      if (s !== undefined) {
        const { waitingFor: _w, ...rest } = item
        out.push({
          ...rest,
          // A Holi or an automation names its run better than its session does.
          title: item.by !== undefined || s.name === NEW_SESSION ? item.title : s.name,
          state: s.state,
          agent: s.provider,
          updatedAt: Math.max(item.updatedAt, s.startedAt ?? 0),
          ...((s.model ?? item.model) === undefined ? {} : { model: s.model ?? item.model }),
          ...(s.waitingFor === undefined ? {} : { waitingFor: s.waitingFor }),
        })
        continue
      }
      // A run whose session is gone has finished: nothing is in flight.
      out.push({ ...item, state: 'idle' })
      continue
    }
    out.push(item)
  }
  for (const s of live) if (!taken.has(s.id)) out.push(liveItem(s))
  // A stopped session no plugin ran: a row of its own, idle, which opening
  // brings back.
  const liveIds = new Set(live.map((s) => s.id))
  for (const s of past) {
    if (!taken.has(s.id) && !liveIds.has(s.id)) out.push({ ...liveItem(s), state: 'idle' })
  }
  return out
}

/** When the person last opened each row, by key, and since when this machine
 *  has kept track: a turn that ended before that is not news. */
export interface SeenRecord {
  since: number
  seen: Record<string, number>
  /** Rows the person marked unread: done until opened, whenever they ended. */
  unread?: Record<string, true>
}

/**
 * The state a row shows. Working and needs-you are the session's own; a
 * finished turn is **done** until the row is opened after it ended, and the
 * row that is open never is (you are looking at it).
 * @public exported for its test
 */
export function rowState(
  item: AgentsSessionItem,
  seen: SeenRecord,
  current: boolean,
  endedAt: number | undefined = item.endedAt,
): SessionRowState {
  if (item.state === 'needs-you') return 'needs-you'
  if (item.state === 'working') return 'working'
  if (current) return 'idle'
  if (seen.unread?.[item.key] === true) return 'done'
  if (endedAt === undefined) return 'idle'
  return endedAt > Math.max(seen.seen[item.key] ?? 0, seen.since) ? 'done' : 'idle'
}

/**
 * MonoCode's `nextUnseenFinishedSessions`, as times: a row that was in flight
 * and is not any more ended its turn now. Kept for the agent's live sessions,
 * whose listing says what they do but not when a turn ended.
 * @public exported for its test
 */
export function nextEndedAt(
  previous: ReadonlyMap<string, AgentsSessionItem['state']>,
  items: readonly AgentsSessionItem[],
  endedAt: Readonly<Record<string, number>>,
  now: number,
): Record<string, number> {
  let next: Record<string, number> | null = null
  for (const item of items) {
    const was = previous.get(item.key)
    if (was !== undefined && was !== 'idle' && item.state === 'idle') {
      next ??= { ...endedAt }
      next[item.key] = now
    }
  }
  return next ?? (endedAt as Record<string, number>)
}

/**
 * Which rows are open in the Sessions list, kept on this machine.
 * @public exported for its test
 */
export interface OpenRecord {
  /** Since when this machine has kept track: rows the person started after
   *  it open on their own; older ones wait in History. */
  since: number
  /** Opened from History, the command menu or an Inbox. */
  opened: Record<string, true>
  /** Closed in the list, by when. */
  closed: Record<string, number>
}

/**
 * Whether a row is in the Sessions list: one that needs you always is (a
 * Holi's run that asks for you); one the person started is from the moment
 * it starts until they close it; any other once they open it.
 */
function isOpenRow(row: SessionRow, rec: OpenRecord): boolean {
  const { item } = row
  if (row.state === 'needs-you') return true
  if (item.archived === true) return false
  if (rec.opened[item.key] === true) return true
  return item.by === undefined && rec.closed[item.key] === undefined && item.updatedAt >= rec.since
}

/** The open rows as the list orders them: what needs you, what is pinned,
 *  then the most recent. */
function openOrder(rows: readonly SessionRow[]): SessionRow[] {
  const rank = (r: SessionRow) => (r.state === 'needs-you' ? 0 : r.item.pinned === true ? 1 : 2)
  return [...rows].sort((a, b) => rank(a) - rank(b) || b.item.updatedAt - a.item.updatedAt)
}

/** Who started the rows a filter keeps. */
export type SessionSource = 'all' | 'mine' | 'agents'

export interface SessionFilter {
  /** The states kept; empty keeps all. `done` keeps every finished row,
   *  read or not. */
  states: readonly ('needs-you' | 'working' | 'done')[]
  source: SessionSource
  archived: boolean
}

export const NO_FILTER: SessionFilter = { states: [], source: 'all', archived: false }

/** Whether the filter narrows anything: the filter button shows it. */
export const filterActive = (f: SessionFilter): boolean =>
  f.states.length > 0 || f.source !== 'all' || f.archived

/** Whether a row passes the search and the filter. */
export function rowMatches(row: SessionRow, query: string, filter: SessionFilter): boolean {
  const { item, state } = row
  if (!filter.archived && item.archived === true) return false
  if (filter.source === 'mine' && item.by !== undefined) return false
  if (filter.source === 'agents' && item.by === undefined) return false
  if (filter.states.length > 0) {
    const as = state === 'idle' ? 'done' : state
    if (!filter.states.includes(as)) return false
  }
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return [item.title, item.by?.name, item.location, modelLabel(item.model, item.agent)].some(
    (text) => text !== undefined && text.toLowerCase().includes(q),
  )
}

type SessionGroupId = 'needs-you' | 'pinned' | 'today' | 'yesterday' | 'earlier'

export interface SessionGroup {
  id: SessionGroupId
  label: string
  rows: SessionRow[]
}

const GROUP_LABEL: Record<SessionGroupId, string> = {
  'needs-you': 'Needs you',
  pinned: 'Pinned',
  today: 'Today',
  yesterday: 'Yesterday',
  earlier: 'Earlier',
}

/**
 * The rows as the list groups them: what needs you first, then what the person
 * pinned, then by the day of their last activity, newest first in each. Empty
 * groups are left out.
 */
export function groupRows(rows: readonly SessionRow[], now: number): SessionGroup[] {
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const today = midnight.getTime()
  const yesterday = new Date(midnight)
  yesterday.setDate(yesterday.getDate() - 1)
  const buckets: Record<SessionGroupId, SessionRow[]> = {
    'needs-you': [],
    pinned: [],
    today: [],
    yesterday: [],
    earlier: [],
  }
  const sorted = [...rows].sort((a, b) => b.item.updatedAt - a.item.updatedAt)
  for (const row of sorted) {
    const at = row.item.updatedAt
    const id: SessionGroupId =
      row.state === 'needs-you'
        ? 'needs-you'
        : row.item.pinned === true
          ? 'pinned'
          : at >= today
            ? 'today'
            : at >= yesterday.getTime()
              ? 'yesterday'
              : 'earlier'
    buckets[id].push(row)
  }
  return (Object.keys(buckets) as SessionGroupId[])
    .filter((id) => buckets[id].length > 0)
    .map((id) => ({ id, label: GROUP_LABEL[id], rows: buckets[id] }))
}

// ----------------------------------------------------------------- atoms

/**
 * When each row was last opened, kept on this machine.
 * @public exported for its test
 */
export const sessionsSeenAtom = atomWithStorage<SeenRecord>('holi.agents.sessions.seen', {
  since: Date.now(),
  seen: {},
})

/**
 * Which rows are open in the Sessions list, kept on this machine.
 * @public exported for its test
 */
export const sessionsOpenAtom = atomWithStorage<OpenRecord>('holi.agents.sessions.open', {
  since: Date.now(),
  opened: {},
  closed: {},
})

/** When each live session's last turn ended, as this window saw it. */
const sessionEndedAtAtom = atom<Record<string, number>>({})

/** The search box's text. */
export const sessionQueryAtom = atom('')

/** The filter menu's choice, kept on this machine. */
export const sessionFilterAtom = atomWithStorage<SessionFilter>(
  'holi.agents.sessions.filter',
  NO_FILTER,
)

/** Every slot's rows and the live sessions, merged. */
const sessionItemsAtom = atom((get): AgentsSessionItem[] => {
  const slotItems = get(agentsSlotsAtom).flatMap((slot) =>
    slot.sessions === undefined ? [] : get(slot.sessions.items),
  )
  return mergeSessionItems(slotItems, get(agentSessionsAtom), get(agentHistoryAtom))
})

/** Whether the slots' rows are in: loading while any is, error while any
 *  failed. */
export const sessionsStatusAtom = atom((get): 'loading' | 'ready' | 'error' => {
  let status: 'loading' | 'ready' | 'error' = 'ready'
  for (const slot of get(agentsSlotsAtom)) {
    const s = slot.sessions?.status === undefined ? 'ready' : get(slot.sessions.status)
    if (s === 'error') return 'error'
    if (s === 'loading') status = 'loading'
  }
  return status
})

/** Ask every slot for its rows again. */
export const reloadSessionsAtom = atom(null, (get, set) => {
  for (const slot of get(agentsSlotsAtom)) {
    if (slot.sessions?.reload !== undefined) set(slot.sessions.reload)
  }
})

/** Whether a row is what the Agents view shows. */
function isCurrent(
  item: AgentsSessionItem,
  selection: { owner: string; id: string } | null,
  sessionView: string | null,
): boolean {
  if (item.selection !== undefined && selection !== null) {
    if (item.selection.owner === selection.owner && item.selection.id === selection.id) return true
  }
  return item.jobId !== undefined && sessionView === item.jobId
}

/** The rows with their states, before search and filter. */
export const sessionRowsAtom = atom((get): SessionRow[] => {
  const seen = get(sessionsSeenAtom)
  const ended = get(sessionEndedAtAtom)
  const selection = get(agentsSelectionAtom)
  const view = get(agentsViewAtom)
  const sessionView = view.kind === 'session' ? view.id : null
  return get(sessionItemsAtom).map((item) => {
    const current = isCurrent(item, selection, sessionView)
    const endedAt = Math.max(item.endedAt ?? 0, ended[item.key] ?? 0) || undefined
    return { item, current, state: rowState(item, seen, current, endedAt) }
  })
})

/**
 * How a session tab looks (the mode's `tabLook`): the row it shows, found as
 * the list finds the open one, by its selection or, for one of the agent's
 * own sessions, its job id.
 */
export const sessionTabLookAtom = atom((get) => {
  const rows = get(sessionRowsAtom)
  return (selection: { owner: string; id: string }): AgentsTabLook | undefined => {
    const view = agentsViewOf(selection)
    if (view.kind === 'inbox') return { title: 'Inbox', state: 'idle' }
    if (view.kind === 'history') return { title: 'History', state: 'idle', icon: HistoryIcon }
    const jobId = view.kind === 'session' ? view.id : null
    const row = rows.find((r) => isCurrent(r.item, selection, jobId))
    if (row === undefined) return undefined
    return {
      title: row.item.title,
      state: row.state,
      ...(row.item.by === undefined ? {} : { by: row.item.by }),
      ...(row.item.agent === undefined ? {} : { agent: row.item.agent }),
    }
  }
})

/** Mark a row read: opening it, its turn ending while it is open, or the
 *  menu's Mark as read. */
export const markSessionSeenAtom = atom(null, (_get, set, key: string) =>
  set(sessionsSeenAtom, (r) => {
    const { [key]: _was, ...unread } = r.unread ?? {}
    return { ...r, seen: { ...r.seen, [key]: Date.now() }, unread }
  }),
)

/** The menu's Mark as unread: the row shows done until it is opened. */
export const markSessionUnreadAtom = atom(null, (_get, set, key: string) =>
  set(sessionsSeenAtom, (r) => ({ ...r, unread: { ...r.unread, [key]: true } })),
)

/**
 * While the vault is open: note when each live session's turn ends (main's
 * listing says what a session does, not when it stopped), and keep the open
 * row read as its turns end. Returns the undo.
 */
export function sessionListVault(store: PluginStore): () => void {
  // Persist the first `since`, so a later launch does not move it.
  store.set(sessionsSeenAtom, (r) => r)
  store.set(sessionsOpenAtom, (r) => r)
  let previous = new Map(store.get(sessionItemsAtom).map((i) => [i.key, i.state]))
  const offItems = store.sub(sessionItemsAtom, () => {
    const items = store.get(sessionItemsAtom)
    const ended = store.get(sessionEndedAtAtom)
    const next = nextEndedAt(previous, items, ended, Date.now())
    if (next !== ended) store.set(sessionEndedAtAtom, next)
    previous = new Map(items.map((i) => [i.key, i.state]))
  })
  // The open row is read: whenever it changes or finishes a turn.
  const offOpen = store.sub(sessionRowsAtom, () => {
    for (const row of store.get(sessionRowsAtom)) {
      if (!row.current || row.item.state !== 'idle') continue
      const seen = store.get(sessionsSeenAtom).seen[row.item.key] ?? 0
      const ended = Math.max(
        row.item.endedAt ?? 0,
        store.get(sessionEndedAtAtom)[row.item.key] ?? 0,
      )
      if (ended > seen) store.set(markSessionSeenAtom, row.item.key)
    }
  })
  return () => {
    offItems()
    offOpen()
    store.set(sessionEndedAtAtom, {})
    store.set(sessionQueryAtom, '')
  }
}

/** The rows open in the Sessions list, in its order. */
export const openSessionRowsAtom = atom((get): SessionRow[] => {
  const rec = get(sessionsOpenAtom)
  return openOrder(get(sessionRowsAtom).filter((r) => isOpenRow(r, rec)))
})

/** Put a row in the Sessions list: opening it from anywhere. */
const keepSessionOpenAtom = atom(null, (_get, set, key: string) =>
  set(sessionsOpenAtom, (r) => {
    if (r.opened[key] === true && r.closed[key] === undefined) return r
    const { [key]: _was, ...closed } = r.closed
    return { ...r, opened: { ...r.opened, [key]: true }, closed }
  }),
)

/**
 * Close a row in the Sessions list: it leaves the list for History, and what
 * it runs stops, through its owner (a Holi's run) or as the agent's live
 * session (`claude stop`). A tab showing it is not closed: that is the tab's.
 */
export const closeSessionRowAtom = atom(null, async (get, set, item: AgentsSessionItem) => {
  set(sessionsOpenAtom, (r) => {
    const { [item.key]: _was, ...opened } = r.opened
    return { ...r, opened, closed: { ...r.closed, [item.key]: Date.now() } }
  })
  const close = ownerSessions(get(agentsSlotsAtom), item.key)?.close
  if (close !== undefined) await set(close, item.key)
  const jobId = item.jobId
  if (jobId !== undefined && get(agentSessionsAtom).some((s) => s.id === jobId)) {
    await set(stopSessionAtom, jobId)
  }
})

/**
 * Open a row: what it selects, or the agent session it is (brought back
 * first when it has finished, its conversation intact). Marks it read, and
 * puts it in the Sessions list.
 */
export const openSessionRowAtom = atom(null, async (get, set, item: AgentsSessionItem) => {
  set(markSessionSeenAtom, item.key)
  set(keepSessionOpenAtom, item.key)
  set(appModeAtom, 'agents')
  if (item.selection !== undefined) {
    set(agentsSelectionAtom, item.selection)
    return { ok: true as const }
  }
  if (item.jobId === undefined) return { ok: true as const }
  const live = get(agentSessionsAtom).some((s) => s.id === item.jobId)
  return set(showSessionAtom, { session: item.jobId, live })
})

/** A new session in the default agent: the list's +, its empty state, ⌘N,
 *  the tab strip's + on the Agents side (the mode's `newSession`). */
export const newSessionAtom = atom(null, (_get, set, beside?: boolean) =>
  set(startViewSessionAtom, beside ? { beside: true } : {}),
)

/** What each owner lets its rows' menu do, by plugin id: only what its slot
 *  backs. */
export interface RowAbilities {
  archive: boolean
  rename: boolean
  pin: boolean
  remove: boolean
}

export const rowAbilitiesAtom = atom(
  (get): ReadonlyMap<string, RowAbilities> =>
    new Map(
      get(agentsSlotsAtom).map((s) => [
        s.plugin,
        {
          archive: s.sessions?.archive !== undefined,
          rename: s.sessions?.rename !== undefined,
          pin: s.sessions?.pin !== undefined,
          remove: s.sessions?.remove !== undefined,
        },
      ]),
    ),
)

/** The slot that owns a row, by its key. */
const ownerSessions = (
  slots: readonly { plugin: string; sessions?: AgentsSessionsSource }[],
  key: string,
): AgentsSessionsSource | undefined => slots.find((s) => s.plugin === keyOwner(key))?.sessions

/** Retitle a row through the slot that owns it. */
export const renameSessionRowAtom = atom(null, (get, set, args: { key: string; title: string }) => {
  const rename = ownerSessions(get(agentsSlotsAtom), args.key)?.rename
  if (rename !== undefined && args.title.trim() !== '') {
    return set(rename, args.key, args.title.trim())
  }
})

/** Pin a row above the day groups, or unpin it, through its owner. */
export const pinSessionRowAtom = atom(null, (get, set, args: { key: string; pinned: boolean }) => {
  const pin = ownerSessions(get(agentsSlotsAtom), args.key)?.pin
  if (pin !== undefined) return set(pin, args.key, args.pinned)
})

/** Delete a row through its owner, once the person has confirmed. */
export const deleteSessionRowAtom = atom(null, (get, set, key: string) => {
  const remove = ownerSessions(get(agentsSlotsAtom), key)?.remove
  if (remove !== undefined) return set(remove, key)
})

/** The plugin a row key belongs to: the part before its first `:`. */
export const keyOwner = (key: string): string => key.slice(0, key.indexOf(':'))

/** Archive a row, or bring it back, through the slot that owns it. */
export const archiveSessionRowAtom = atom(
  null,
  (get, set, args: { key: string; archived: boolean }) => {
    const owner = keyOwner(args.key)
    const archive = get(agentsSlotsAtom).find((s) => s.plugin === owner)?.sessions?.archive
    if (archive !== undefined) return set(archive, args.key, args.archived)
  },
)
