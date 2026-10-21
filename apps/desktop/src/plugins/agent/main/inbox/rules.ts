/**
 * The agent inbox's rules (docs/features/agent-inbox.md), pure: what is kept,
 * what is a repeat, when a banner is allowed, and which sessions just started
 * needing you.
 *
 * **Quiet by default.** An entry is the record; a native banner is the
 * exception. A notice the inbox already holds from the last few minutes is a
 * repeat and raises nothing. Banners are spaced: a burst of notices lands in
 * the inbox, and only the first of them on screen.
 *
 * No Electron import: this loads under plain Node like the rest of the plugin.
 */
import type { SessionSummary } from '../claude/listing'

/** Machine state, beside the turn records. Gitignored by the `.local.` marker. */
export const INBOX_FILE = '.holi/state/inbox.local.json'

/** Enough for a day of an agent that notifies sparingly; the file is read and
 *  rewritten whole on every change. */
export const INBOX_CAP = 50

/** A notice equal to one the inbox got this recently is a repeat. */
export const REPEAT_MS = 5 * 60_000

/** The least time between two banners. */
export const BANNER_GAP_MS = 30_000

/** What someone asked to tell the person. */
export interface InboxNotice {
  title: string
  line: string
  /** A vault path the entry opens. */
  path?: string
  /** A session, by job id, the entry opens. */
  session?: string
}

export interface InboxEntry extends InboxNotice {
  id: string
  /** ISO time it arrived. */
  at: string
}

export interface InboxFile {
  /** Newest first, at most `INBOX_CAP`. */
  entries: InboxEntry[]
  /** ISO time the person last looked at the inbox; null for never. */
  seen: string | null
}

/** What the renderer is told. */
export interface InboxView {
  entries: InboxEntry[]
  unread: number
}

const text = (value: unknown): value is string => typeof value === 'string' && value !== ''

function toEntry(value: unknown): InboxEntry | null {
  if (value === null || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  if (!text(r['id']) || !text(r['at']) || !text(r['title']) || typeof r['line'] !== 'string') {
    return null
  }
  return {
    id: r['id'],
    at: r['at'],
    title: r['title'],
    line: r['line'],
    ...(text(r['path']) ? { path: r['path'] } : {}),
    ...(text(r['session']) ? { session: r['session'] } : {}),
  }
}

/** The file as read: anything missing or malformed is an empty inbox, entry
 *  by entry, so one hand-edited entry does not cost the rest. */
export function parseInbox(raw: unknown): InboxFile {
  if (raw === null || typeof raw !== 'object') return { entries: [], seen: null }
  const r = raw as Record<string, unknown>
  const entries = Array.isArray(r['entries'])
    ? r['entries'].map(toEntry).filter((e): e is InboxEntry => e !== null)
    : []
  return { entries: entries.slice(0, INBOX_CAP), seen: text(r['seen']) ? r['seen'] : null }
}

const sameNotice = (a: InboxNotice, b: InboxNotice): boolean =>
  a.title === b.title && a.line === b.line && a.path === b.path && a.session === b.session

/**
 * Whether `notice` goes in, and whether it may also be a banner. A repeat of
 * an entry still in the inbox from the last `REPEAT_MS` is dropped. A banner
 * waits `BANNER_GAP_MS` after the previous one (`lastBanner`, epoch ms).
 */
export function admit(
  file: InboxFile,
  notice: InboxNotice,
  now: number,
  lastBanner: number | null,
): { kind: 'repeat' } | { kind: 'new'; banner: boolean } {
  const repeat = file.entries.some(
    (e) => sameNotice(e, notice) && now - Date.parse(e.at) < REPEAT_MS,
  )
  if (repeat) return { kind: 'repeat' }
  return { kind: 'new', banner: lastBanner === null || now - lastBanner >= BANNER_GAP_MS }
}

/** `entry` first, the oldest past the cap dropped. */
export const withEntry = (file: InboxFile, entry: InboxEntry): InboxFile => ({
  ...file,
  entries: [entry, ...file.entries].slice(0, INBOX_CAP),
})

export const withoutEntry = (file: InboxFile, id: string): InboxFile => ({
  ...file,
  entries: file.entries.filter((e) => e.id !== id),
})

/** The entries that came after the person last looked. */
export function unreadCount(file: InboxFile): number {
  if (file.seen === null) return file.entries.length
  const seen = Date.parse(file.seen)
  return file.entries.filter((e) => Date.parse(e.at) > seen).length
}

export const viewOf = (file: InboxFile): InboxView => ({
  entries: file.entries,
  unread: unreadCount(file),
})

/**
 * The sessions that went into needs-you since the last list, and the set to
 * compare the next list with. An edge, not a level: a session that stays
 * waiting is reported once, and again only after it has stopped waiting.
 */
export function enteredNeedsYou(
  waiting: ReadonlySet<string>,
  sessions: readonly SessionSummary[],
): { entered: SessionSummary[]; waiting: Set<string> } {
  const now = sessions.filter((s) => s.state === 'needs-you')
  return {
    entered: now.filter((s) => !waiting.has(s.id)),
    waiting: new Set(now.map((s) => s.id)),
  }
}
