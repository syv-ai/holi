/**
 * The Google cache — what a launch paints before Google answers.
 *
 * **This overturns D67 §7's "nothing persisted", on Nicolai's call.** What it
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
import type { MailThreadSummary } from './gmail'

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
  readAgenda(key: string): CalendarEvent[] | null
  writeAgenda(key: string, events: CalendarEvent[]): void
  /** Gmail's `historyId`, the cursor incremental sync resumes from. */
  historyId(): string | null
  setHistoryId(id: string): void
  /** Delete the database file. Disconnect calls this. */
  destroy(): void
  close(): void
}

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
  const db = open(path)
  let closed = false

  /**
   * Has this question been answered before?
   *
   * Tracked separately from the rows, because "cached, and the answer was
   * nothing" is a different fact from "never asked" — and only the second one
   * means go and ask Google.
   */
  function isAnswered(kind: string, key: string): boolean {
    return db.prepare('SELECT 1 FROM answered WHERE kind = ? AND key = ?').get(kind, key) !== undefined
  }

  function markAnswered(kind: string, key: string): void {
    db.prepare('INSERT OR REPLACE INTO answered (kind, key) VALUES (?, ?)').run(kind, key)
  }

  return {
    useAccount(sub) {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'account'").get() as
        | { value?: string }
        | undefined
      if (row?.value === sub) return
      // A different account — or the first one. Everything held belongs to
      // whoever was connected before, and none of it is theirs to see.
      db.exec('DELETE FROM threads; DELETE FROM agenda; DELETE FROM answered; DELETE FROM meta;')
      db.prepare("INSERT INTO meta (key, value) VALUES ('account', ?)").run(sub)
    },

    readThreads(key) {
      if (!isAnswered('threads', key)) return null
      const rows = db
        .prepare('SELECT json FROM threads WHERE key = ? ORDER BY position')
        .all(key) as { json: string }[]
      return rows.map((row) => JSON.parse(row.json) as MailThreadSummary)
    },

    writeThreads(key, threads) {
      // Replaced, never appended: a thread that has left the inbox must leave
      // the cache with it, or the list grows things the mailbox no longer has.
      db.prepare('DELETE FROM threads WHERE key = ?').run(key)
      const insert = db.prepare(
        'INSERT INTO threads (key, position, id, json) VALUES (?, ?, ?, ?)',
      )
      threads.slice(0, MAX_THREADS).forEach((thread, position) => {
        insert.run(key, position, thread.id, JSON.stringify(thread))
      })
      markAnswered('threads', key)
    },

    readAgenda(key) {
      if (!isAnswered('agenda', key)) return null
      const rows = db
        .prepare('SELECT json FROM agenda WHERE key = ? ORDER BY position')
        .all(key) as { json: string }[]
      return rows.map((row) => JSON.parse(row.json) as CalendarEvent)
    },

    writeAgenda(key, events) {
      db.prepare('DELETE FROM agenda WHERE key = ?').run(key)
      const insert = db.prepare('INSERT INTO agenda (key, position, json) VALUES (?, ?, ?)')
      events.forEach((event, position) => {
        insert.run(key, position, JSON.stringify(event))
      })
      markAnswered('agenda', key)
    },

    historyId() {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'historyId'").get() as
        | { value?: string }
        | undefined
      return row?.value ?? null
    },

    setHistoryId(id) {
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('historyId', ?)").run(id)
    },

    destroy() {
      // The FILE, not the rows. Emptying the tables would leave recoverable
      // pages on a disk Disconnect said it had cleaned — and it is not reopened
      // afterwards, because reopening would put the file straight back.
      close()
      removeFiles(path)
    },

    close,
  }

  function close(): void {
    if (closed) return
    closed = true
    db.close()
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

function removeFiles(path: string): void {
  rmSync(path, { force: true })
  for (const suffix of SIDECARS) rmSync(`${path}${suffix}`, { force: true })
}
