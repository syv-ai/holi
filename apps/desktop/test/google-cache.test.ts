/**
 * The Google cache — what launching paints before Google answers.
 *
 * The tests that matter here are the two that would be a *breach* rather than
 * a bug: that connecting a second account cannot show the first account's
 * inbox, and that Disconnect leaves no file behind. Disconnect already revokes
 * at Google and clears the keychain; mail left on disk would make the button a
 * lie.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openGoogleCache, type GoogleCache } from '../src/main/google/cache'
import type { MailThreadSummary } from '../src/main/google/gmail'
import type { CalendarEvent } from '../src/main/google/calendar'

let dir: string
let path: string
let cache: GoogleCache

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holi-google-cache-'))
  path = join(dir, 'google-cache.db')
  cache = openGoogleCache(path)
})

afterEach(async () => {
  cache.close()
  await rm(dir, { recursive: true, force: true })
})

function thread(id: string, overrides: Partial<MailThreadSummary> = {}): MailThreadSummary {
  return {
    id,
    subject: `Subject ${id}`,
    from: { name: 'Jane', email: 'jane@example.com' },
    date: '2026-08-04T09:00:00.000Z',
    snippet: 'a snippet',
    unread: false,
    answered: false,
    messageCount: 1,
    webUrl: `https://mail.google.com/${id}`,
    starred: false,
    important: false,
    hasDraft: false,
    category: 'primary',
    labels: [],
    unsubscribeUrl: null,
    ...overrides,
  }
}

function event(id: string): CalendarEvent {
  return {
    id,
    title: `Event ${id}`,
    start: '2026-08-04T09:00:00.000Z',
    end: '2026-08-04T10:00:00.000Z',
    allDay: false,
    htmlLink: `https://calendar.google.com/${id}`,
    calendarId: 'primary',
    calendarName: 'Me',
    mine: true,
    color: '#039be5',
    myResponse: null,
    kind: 'default',
    busy: true,
    description: null,
    attendeeCount: 0,
    organizer: null,
    conferenceUrl: null,
    recurring: false,
  }
}

describe('GoogleCache', () => {
  it('returns null before anything has been cached', () => {
    cache.useAccount('sub-a')

    // Null, not an empty list: "nothing cached" and "the inbox is empty" are
    // different answers, and only one of them means "go and ask Google".
    expect(cache.readThreads('in:inbox|primary')).toBeNull()
    expect(cache.readAgenda('2026-08-04|primary')).toBeNull()
    expect(cache.historyId('in:inbox|primary')).toBeNull()
  })

  it('round-trips a thread list', () => {
    cache.useAccount('sub-a')
    const threads = [thread('t1', { starred: true, labels: ['Work'] }), thread('t2')]

    cache.writeThreads('in:inbox|primary', threads)

    expect(cache.readThreads('in:inbox|primary')).toEqual(threads)
  })

  it('round-trips an agenda', () => {
    cache.useAccount('sub-a')
    const events = [event('e1'), event('e2')]

    cache.writeAgenda('2026-08-04|primary', events)

    expect(cache.readAgenda('2026-08-04|primary')).toEqual(events)
  })

  it('never serves one query’s results for another', () => {
    cache.useAccount('sub-a')
    cache.writeThreads('in:inbox|primary', [thread('t1')])

    // A cached answer belongs to the question that produced it. Serving the
    // inbox for a search would be a list that quietly does not match its query.
    expect(cache.readThreads('from:jane|primary')).toBeNull()
    expect(cache.readThreads('in:inbox|promotions')).toBeNull()
  })

  it('wipes everything when a different Google account connects', () => {
    cache.useAccount('sub-a')
    cache.writeThreads('in:inbox|primary', [thread('secret', { subject: 'Client contract' })])
    cache.writeAgenda('2026-08-04|primary', [event('e1')])
    cache.setHistoryId('in:inbox|primary', '9001')

    cache.useAccount('sub-b')

    // The security-relevant one. Account B must not see A's inbox, agenda, or
    // history cursor — and it is `useAccount` that guarantees it, before any
    // read can happen.
    expect(cache.readThreads('in:inbox|primary')).toBeNull()
    expect(cache.readAgenda('2026-08-04|primary')).toBeNull()
    expect(cache.historyId('in:inbox|primary')).toBeNull()
  })

  it('keeps a reconnect of the SAME account', () => {
    cache.useAccount('sub-a')
    cache.writeThreads('in:inbox|primary', [thread('t1')])

    cache.useAccount('sub-a')

    // Otherwise the cache would be empty on every launch and buy nothing.
    expect(cache.readThreads('in:inbox|primary')).toHaveLength(1)
  })

  it('keeps only the newest N threads', () => {
    cache.useAccount('sub-a')
    const many = Array.from({ length: 620 }, (_, i) => thread(`t${i}`))

    cache.writeThreads('in:inbox|primary', many)

    // Bounded, newest first: this is a "last N, refetch older" cache, not a
    // mirror of the mailbox. Paging past the tail is a request, not a read.
    const cached = cache.readThreads('in:inbox|primary')!
    expect(cached).toHaveLength(500)
    expect(cached[0]!.id).toBe('t0')
    expect(cached.at(-1)!.id).toBe('t499')
  })

  it('replaces a query’s results rather than appending to them', () => {
    cache.useAccount('sub-a')
    cache.writeThreads('in:inbox|primary', [thread('old')])

    cache.writeThreads('in:inbox|primary', [thread('new')])

    // A thread that has left the inbox must leave the cache with it, or the
    // list grows things the mailbox no longer contains.
    expect(cache.readThreads('in:inbox|primary')!.map((t) => t.id)).toEqual(['new'])
  })

  it('remembers the Gmail history id across a close', () => {
    cache.useAccount('sub-a')
    cache.setHistoryId('in:inbox|primary', '9001')
    cache.close()

    const reopened = openGoogleCache(path)
    reopened.useAccount('sub-a')
    expect(reopened.historyId('in:inbox|primary')).toBe('9001')
    reopened.close()
  })

  it('destroy leaves no file behind', () => {
    cache.useAccount('sub-a')
    cache.writeThreads('in:inbox|primary', [thread('t1')])
    expect(existsSync(path)).toBe(true)

    cache.destroy()

    // Disconnect promises exactly this. Emptying the tables would leave a file
    // full of recoverable mail on a disk the user was told was clean.
    expect(existsSync(path)).toBe(false)
  })

  it('is usable again after a destroy, holding none of what it held', () => {
    cache.useAccount('sub-a')
    cache.writeThreads('in:inbox|primary', [thread('t1')])

    cache.destroy()

    // Disconnect then reconnect is an ordinary thing to do inside one run of
    // the app, and it must not need a restart to work.
    cache.useAccount('sub-a')
    expect(cache.readThreads('in:inbox|primary')).toBeNull()
    cache.writeThreads('in:inbox|primary', [thread('t2')])
    expect(cache.readThreads('in:inbox|primary')!.map((t) => t.id)).toEqual(['t2'])
  })

  it('survives a corrupt database file rather than crashing', async () => {
    cache.close()
    await writeFile(path, 'this is not a database', 'utf8')

    // The same stance as `token-store`: a bad file costs the cache, never the
    // app. It must open, answer "nothing cached", and take writes again.
    const reopened = openGoogleCache(path)
    expect(() => reopened.useAccount('sub-a')).not.toThrow()
    expect(reopened.readThreads('in:inbox|primary')).toBeNull()
    expect(() => reopened.writeThreads('in:inbox|primary', [thread('t1')])).not.toThrow()
    reopened.close()
  })
})

/**
 * The row shape, which SQLite cannot see.
 *
 * `threads` and `agenda` hold whole objects as JSON, so changing a cached type
 * is invisible to the schema and invisible on read: the row parses fine and is
 * simply the wrong shape. It then breaks at the render, far from the change
 * that caused it — which is the failure this guard exists to prevent.
 */
describe('shape version', () => {
  it('drops rows written by an older shape, for the same account', () => {
    cache.useAccount('sub-1')
    cache.writeThreads('inbox', [thread('t1')])
    expect(cache.readThreads('inbox')).toHaveLength(1)
    cache.close()

    // Stand where a user upgrading the app stands: the same account, rows still
    // on disk, and a shape stamp from the release before. Written directly
    // because no public method can produce it — the old build simply wrote a
    // different value here.
    const raw = new DatabaseSync(path)
    raw.prepare("UPDATE meta SET value = '1' WHERE key = 'shape'").run()
    raw.close()

    cache = openGoogleCache(path)
    cache.useAccount('sub-1')

    // Wiped, not served. The rows would have parsed perfectly and been the
    // wrong shape — `from` as a bare string where the UI now reads `.name` —
    // and the failure would have surfaced at the render.
    expect(cache.readThreads('inbox')).toBeNull()
  })

  it('keeps the cache when the account and shape both match', () => {
    cache.useAccount('sub-1')
    cache.writeThreads('inbox', [thread('t1')])

    cache.useAccount('sub-1')

    // The guard must not wipe on every launch — that would turn the cache into
    // an expensive way of doing nothing.
    expect(cache.readThreads('inbox')).toHaveLength(1)
  })
})
