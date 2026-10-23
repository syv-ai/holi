/**
 * The Agents sidebar's one session list (docs/features/agent-sessions.md, The
 * Agents view): the rows every plugin adds through its slot (chats, a Holi's
 * runs, an automation's runs) and the agent's own live sessions, merged by job
 * id, with the state each row shows, the filter, and the groups.
 *
 * The states are after MonoCode's session cards (MIT, Copyright (c) 2026
 * Nick; see NOTICE.md): working while a turn is in flight, needs you while a
 * permission prompt or a question waits, and done from the moment a turn ends
 * until the row is opened ("Sessions that finished while unfocused, until the
 * user looks at them", MonoCode's `sessionDone.ts`).
 */
import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import {
  activeRemoteAtom,
  agentsSelectionAtom,
  appModeAtom,
  agentsSlotsAtom,
  type AgentsSessionItem,
  type PluginStore,
} from '@/plugin-api'
import { agentsViewAtom } from './agents-view'
import { newViewSessionAtom, showSessionAtom } from './session-view'
import { NEW_SESSION, agentSessionsAtom, type AgentSession } from './sessions'

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
export function modelLabel(model: string | undefined): string {
  if (model === undefined || model.trim() === '') return 'Claude'
  const m = /^(?:claude-)?(opus|sonnet|haiku)(?:-(\d+)(?:-(\d{1,2}))?)?(?:-\d{8})?(\[1m\])?$/i.exec(
    model.trim(),
  )
  if (m === null) return model
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase()
  const version = m[2] === undefined ? '' : ` ${m[2]}${m[3] === undefined ? '' : `.${m[3]}`}`
  return `${family}${version}`
}

/** The agent's own live session as a row. */
export function liveItem(s: AgentSession): AgentsSessionItem {
  return {
    key: `agent:${s.id}`,
    jobId: s.id,
    title: s.name,
    state: s.state,
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
 * automation's for the same session.
 */
export function mergeSessionItems(
  slotItems: readonly AgentsSessionItem[],
  live: readonly AgentSession[],
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
  return out
}

/** When the person last opened each row, by key, and since when this machine
 *  has kept track: a turn that ended before that is not news. */
export interface SeenRecord {
  since: number
  seen: Record<string, number>
}

/**
 * The state a row shows. Working and needs-you are the session's own; a
 * finished turn is **done** until the row is opened after it ended, and the
 * row that is open never is (you are looking at it).
 */
export function rowState(
  item: AgentsSessionItem,
  seen: SeenRecord,
  current: boolean,
  endedAt: number | undefined = item.endedAt,
): SessionRowState {
  if (item.state === 'needs-you') return 'needs-you'
  if (item.state === 'working') return 'working'
  if (current || endedAt === undefined) return 'idle'
  return endedAt > Math.max(seen.seen[item.key] ?? 0, seen.since) ? 'done' : 'idle'
}

/**
 * MonoCode's `nextUnseenFinishedSessions`, as times: a row that was in flight
 * and is not any more ended its turn now. Kept for the agent's live sessions,
 * whose listing says what they do but not when a turn ended.
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
  return [item.title, item.by?.name, item.location, modelLabel(item.model)].some(
    (text) => text !== undefined && text.toLowerCase().includes(q),
  )
}

export type SessionGroupId = 'needs-you' | 'today' | 'yesterday' | 'earlier'

export interface SessionGroup {
  id: SessionGroupId
  label: string
  rows: SessionRow[]
}

const GROUP_LABEL: Record<SessionGroupId, string> = {
  'needs-you': 'Needs you',
  today: 'Today',
  yesterday: 'Yesterday',
  earlier: 'Earlier',
}

/**
 * The rows as the list groups them: what needs you pinned first, then by the
 * day of their last activity, newest first in each. Empty groups are left out.
 */
export function groupRows(rows: readonly SessionRow[], now: number): SessionGroup[] {
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const today = midnight.getTime()
  const yesterday = new Date(midnight)
  yesterday.setDate(yesterday.getDate() - 1)
  const buckets: Record<SessionGroupId, SessionRow[]> = {
    'needs-you': [],
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

/** "now", "10m", "5h 43m", "3d", then "7 Oct": how long ago, as MonoCode's
 *  `formatRelative` puts it. */
export function age(at: number, now: number): string {
  if (!Number.isFinite(at) || at <= 0) return ''
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return rest ? `${hours}h ${rest}m` : `${hours}h`
  }
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(at))
}

/** The vault as a person names it: `notes` for `owner/notes`. */
export const vaultName = (remote: string | null): string =>
  remote === null ? '' : (remote.split('/').pop() ?? remote)

// ----------------------------------------------------------------- atoms

/** When each row was last opened, kept on this machine. */
export const sessionsSeenAtom = atomWithStorage<SeenRecord>('holi.agents.sessions.seen', {
  since: Date.now(),
  seen: {},
})

/** When each live session's last turn ended, as this window saw it. */
export const sessionEndedAtAtom = atom<Record<string, number>>({})

/** The search box's text. */
export const sessionQueryAtom = atom('')

/** The filter menu's choice, kept on this machine. */
export const sessionFilterAtom = atomWithStorage<SessionFilter>(
  'holi.agents.sessions.filter',
  NO_FILTER,
)

/** Every slot's rows and the live sessions, merged. */
export const sessionItemsAtom = atom((get): AgentsSessionItem[] => {
  const slotItems = get(agentsSlotsAtom).flatMap((slot) =>
    slot.sessions === undefined ? [] : get(slot.sessions.items),
  )
  return mergeSessionItems(slotItems, get(agentSessionsAtom))
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
export function isCurrent(
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

/** Mark a row read: opening it, or its turn ending while it is open. */
export const markSessionSeenAtom = atom(null, (_get, set, key: string) =>
  set(sessionsSeenAtom, (r) => ({ ...r, seen: { ...r.seen, [key]: Date.now() } })),
)

/**
 * While the vault is open: note when each live session's turn ends (main's
 * listing says what a session does, not when it stopped), and keep the open
 * row read as its turns end. Returns the undo.
 */
export function sessionListVault(store: PluginStore): () => void {
  // Persist the first `since`, so a later launch does not move it.
  store.set(sessionsSeenAtom, (r) => r)
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

/** The vault's name, for each row's third line. */
export const sessionVaultNameAtom = atom((get) => vaultName(get(activeRemoteAtom)))

/**
 * Open a row: what it selects, or the agent session it is (brought back
 * first when it has finished, its conversation intact). Marks it read.
 */
export const openSessionRowAtom = atom(null, async (get, set, item: AgentsSessionItem) => {
  set(markSessionSeenAtom, item.key)
  set(appModeAtom, 'agents')
  if (item.selection !== undefined) {
    set(agentsSelectionAtom, item.selection)
    return { ok: true as const }
  }
  if (item.jobId === undefined) return { ok: true as const }
  const live = get(agentSessionsAtom).some((s) => s.id === item.jobId)
  return set(showSessionAtom, { session: item.jobId, live })
})

/**
 * A new session, in whichever view a slot offers for it (chat's composer),
 * else the agent's own: the list's +, its empty state, and ⌘N.
 */
export const newSessionAtom = atom(null, async (get, set) => {
  const create = get(agentsSlotsAtom).find((s) => s.sessions?.create !== undefined)?.sessions
    ?.create
  if (create !== undefined) {
    await set(create)
    set(appModeAtom, 'agents')
    return
  }
  await set(newViewSessionAtom)
})

/** Whether a row's owner can archive it (its slot's `archive`). */
export const archivableOwnersAtom = atom(
  (get) =>
    new Set(
      get(agentsSlotsAtom)
        .filter((s) => s.sessions?.archive !== undefined)
        .map((s) => s.plugin),
    ),
)

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
