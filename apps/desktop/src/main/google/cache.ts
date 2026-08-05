/**
 * The Google cache — what a launch paints before Google answers.
 *
 * **This overturns D67 §7's "nothing persisted", by an explicit call.** What it
 * is not is a mirror: it holds the last N threads for the questions actually
 * asked, and Google stays the source of truth. Anything past the tail is a
 * request, an account change wipes it, and Disconnect deletes the file. What it
 * buys is real — with `mail-sync.ts` on top, a refresh with nothing new costs
 * **one request instead of twenty-six**.
 *
 * **The database is unencrypted, deliberately.** SQLCipher is a native module
 * (and `node:sqlite` is precisely the dependency this avoids), and encrypting
 * the columns by hand would foreclose the FTS5 search this schema is shaped
 * for. The protection is the OS account and full-disk encryption — the same
 * protection every desktop mail client relies on, and the same one already
 * protecting the vault's own notes sitting beside it.
 *
 * `node:sqlite` is **synchronous**, and this API is synchronous with it. Async
 * wrappers here would buy nothing but the appearance of one.
 *
 * NOTE: no runtime `electron` import — every file in `google/` except
 * `electron.ts` avoids it, so the suite runs under plain Node.
 */
import { DatabaseSync } from 'node:sqlite'
import { rmSync } from 'node:fs'
import type { CalendarEvent } from './calendar'
import { applyLabelDelta, type MailThreadSummary } from './gmail'

/**
 * How many threads a single query keeps.
 *
 * The "last N, refetch older" shape: 500 covers every list a person actually
 * scrolls, and paging past it is a `pageToken` fetch rather than a cache read.
 */
const MAX_THREADS = 500

/** SQLite writes these beside the database; deleting the db alone would leave
 *  recoverable pages on a disk the user was told is clean. */
const SIDECARS = ['-wal', '-shm', '-journal']

export interface GoogleCache {
  /** Wipes everything if `sub` differs from the stored account. **Call before
   *  any read** — it is what stops one account seeing another's mail. */
  useAccount(sub: string): void
  readThreads(key: string): MailThreadSummary[] | null
  writeThreads(key: string, threads: MailThreadSummary[]): void
  /**
   * Apply a label change to one thread **in every list that holds it**.
   *
   * The key is `query|category`, so a thread is cached once per question it
   * answered — the inbox, the unread filter, a search. Patching only the list on
   * screen is the bug this signature forbids: bold clearing in the inbox while
   * the unread filter still lists the thread leaves two views disagreeing, with
   * neither obviously wrong.
   *
   * Optimism, not truth. `history.list` reports this app's own writes, so the
   * next `syncThreads` reconciles every list regardless of what happened here.
   */
  patchThread(id: string, change: { added: string[]; removed: string[] }): void
  /** Remove a thread from every cached list — what archive and trash do. Also
   *  optimism: a search that still legitimately matches gets it back on the
   *  next sync, because this is a cache and not a mirror. */
  dropThread(id: string): void
  readAgenda(key: string): CalendarEvent[] | null
  writeAgenda(key: string, events: CalendarEvent[]): void
  /**
   * Gmail's `historyId` for one cached list — the cursor its next delta
   * resumes from.
   *
   * **Per list, not per mailbox**, even though Gmail's cursor is mailbox-wide.
   * Each list was written at a different moment, and asking "what changed since
   * 200?" against a list last written at 100 silently loses everything in
   * between. The cursor belongs to the list it was taken for.
   */
  historyId(key: string): string | null
  setHistoryId(key: string, id: string): void
  /** Delete the database file. Disconnect calls this. */
  destroy(): void
  close(): void
}

/**
 * The shape of the rows, not the shape of the tables.
 *
 * `threads` and `agenda` hold whole objects as JSON, so a change to
 * `MailThreadSummary` or `CalendarEvent` is invisible to SQLite and invisible
 * on read — the row parses fine and is simply wrong. **Bump this whenever a
 * cached type changes.** `2` is where `from` became `{ name, email }` instead
 * of a bare display name.
 *
 * `3` is not a type change: `cacheKey` gained the unread filter, so every key
 * written before it is a question this build no longer asks. The rows would
 * never be read again and would sit on disk until the account changed — wiping
 * is both free and the only way the old keys ever leave.
 */
const SHAPE_VERSION = '3'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS threads (
    key      TEXT    NOT NULL,
    position INTEGER NOT NULL,
    id       TEXT    NOT NULL,
    json     TEXT    NOT NULL,
    PRIMARY KEY (key, position)
  );
  CREATE TABLE IF NOT EXISTS agenda (
    key      TEXT    NOT NULL,
    position INTEGER NOT NULL,
    json     TEXT    NOT NULL,
    PRIMARY KEY (key, position)
  );
  CREATE TABLE IF NOT EXISTS answered (
    kind TEXT NOT NULL,
    key  TEXT NOT NULL,
    PRIMARY KEY (kind, key)
  );
`

/**
 * Open the cache, replacing it if the file is not a database.
 *
 * The same stance as `token-store`: a corrupt file costs the cache and never
 * the app. SQLite reports the corruption on first use rather than on open, so
 * the schema statement is the probe.
 */
export function openGoogleCache(path: string): GoogleCache {
  let handle: DatabaseSync | null = open(path)
  let closed = false

  /**
   * The database, reopened if `destroy` took it away.
   *
   * Lazy rather than eager, so `destroy()` genuinely leaves nothing on disk —
   * reopening on the spot would put the file straight back, and Disconnect
   * promises an empty disk, not an empty table.
   */
  function database(): DatabaseSync {
    if (closed) throw new Error('the Google cache is closed')
    handle ??= open(path)
    return handle
  }

  /**
   * Has this question been answered before?
   *
   * Tracked separately from the rows, because "cached, and the answer was
   * nothing" is a different fact from "never asked" — and only the second one
   * means go and ask Google.
   */
  function isAnswered(kind: string, key: string): boolean {
    return database().prepare('SELECT 1 FROM answered WHERE kind = ? AND key = ?').get(kind, key) !== undefined
  }

  function markAnswered(kind: string, key: string): void {
    database().prepare('INSERT OR REPLACE INTO answered (kind, key) VALUES (?, ?)').run(kind, key)
  }

  return {
    useAccount(sub) {
      const read = (key: string): string | undefined =>
        (database().prepare('SELECT value FROM meta WHERE key = ?').get(key) as
          | { value?: string }
          | undefined)?.value

      // Same account AND same row shape. The shape half is what stops a release
      // that changes `MailThreadSummary` from serving yesterday's JSON into
      // today's UI — rows are stored as whole objects, so a field that changed
      // type arrives looking like the old one and breaks at the render, far
      // from the change that caused it. Wiping is free: this is a cache.
      if (read('account') === sub && read('shape') === SHAPE_VERSION) return

      // A different account — or the first one. Everything held belongs to
      // whoever was connected before, and none of it is theirs to see.
      database().exec('DELETE FROM threads; DELETE FROM agenda; DELETE FROM answered; DELETE FROM meta;')
      const write = database().prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      write.run('account', sub)
      write.run('shape', SHAPE_VERSION)
    },

    readThreads(key) {
      if (!isAnswered('threads', key)) return null
      const rows = database()
        .prepare('SELECT json FROM threads WHERE key = ? ORDER BY position')
        .all(key) as { json: string }[]
      return rows.map((row) => JSON.parse(row.json) as MailThreadSummary)
    },

    writeThreads(key, threads) {
      // Replaced, never appended: a thread that has left the inbox must leave
      // the cache with it, or the list grows things the mailbox no longer has.
      database().prepare('DELETE FROM threads WHERE key = ?').run(key)
      const insert = database().prepare(
        'INSERT INTO threads (key, position, id, json) VALUES (?, ?, ?, ?)',
      )
      threads.slice(0, MAX_THREADS).forEach((thread, position) => {
        insert.run(key, position, thread.id, JSON.stringify(thread))
      })
      markAnswered('threads', key)
    },

    patchThread(id, change) {
      // The `id` column has been written since this table existed and read by
      // nothing until now. It is what makes "every list holding this thread"
      // a query rather than an enumeration of keys and a JSON parse per row.
      const rows = database()
        .prepare('SELECT key, position, json FROM threads WHERE id = ?')
        .all(id) as { key: string; position: number; json: string }[]
      if (rows.length === 0) return

      const added = new Set(change.added)
      const removed = new Set(change.removed)
      const update = database().prepare('UPDATE threads SET json = ? WHERE key = ? AND position = ?')
      for (const row of rows) {
        const patched = applyLabelDelta(JSON.parse(row.json) as MailThreadSummary, { added, removed })
        update.run(JSON.stringify(patched), row.key, row.position)
      }
    },

    dropThread(id) {
      // `position` is deliberately NOT renumbered. `readThreads` only orders by
      // it, so a gap is invisible — and rewriting every later row is a second
      // chance to corrupt an order that was already correct.
      database().prepare('DELETE FROM threads WHERE id = ?').run(id)
    },

    readAgenda(key) {
      if (!isAnswered('agenda', key)) return null
      const rows = database()
        .prepare('SELECT json FROM agenda WHERE key = ? ORDER BY position')
        .all(key) as { json: string }[]
      return rows.map((row) => JSON.parse(row.json) as CalendarEvent)
    },

    writeAgenda(key, events) {
      database().prepare('DELETE FROM agenda WHERE key = ?').run(key)
      const insert = database().prepare('INSERT INTO agenda (key, position, json) VALUES (?, ?, ?)')
      events.forEach((event, position) => {
        insert.run(key, position, JSON.stringify(event))
      })
      markAnswered('agenda', key)
    },

    historyId(key) {
      const row = database().prepare('SELECT value FROM meta WHERE key = ?').get(historyKey(key)) as
        | { value?: string }
        | undefined
      return row?.value ?? null
    },

    setHistoryId(key, id) {
      database().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(historyKey(key), id)
    },

    destroy() {
      // The FILE, not the rows. Emptying the tables would leave recoverable
      // pages on a disk Disconnect said it had cleaned. Nothing is reopened
      // here either — `database()` does that on the next use, so a disconnect
      // followed by a reconnect works without leaving a file behind meanwhile.
      handle?.close()
      handle = null
      removeFiles(path)
    },

    close() {
      if (closed) return
      closed = true
      handle?.close()
      handle = null
    },
  }
}

/** Open, using the schema statement as the corruption probe: SQLite reports a
 *  bad file on first use rather than on open. */
function open(at: string): DatabaseSync {
  const opened = new DatabaseSync(at)
  try {
    opened.exec(SCHEMA)
    return opened
  } catch {
    // Not a database, or one this build cannot read. Start over rather than
    // fail the connector — nothing in here is authoritative.
    opened.close()
    removeFiles(at)
    const fresh = new DatabaseSync(at)
    fresh.exec(SCHEMA)
    return fresh
  }
}

/** Namespaced so a list key can never collide with `account`. */
function historyKey(key: string): string {
  return `historyId:${key}`
}

function removeFiles(path: string): void {
  rmSync(path, { force: true })
  for (const suffix of SIDECARS) rmSync(`${path}${suffix}`, { force: true })
}
