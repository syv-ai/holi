/**
 * The UI's cached Google data, and the line the agent stays on the other side
 * of.
 *
 * Three properties, and the first is the one that would be a broken promise
 * rather than a bug: Disconnect already revokes at Google and clears the
 * keychain, so mail left on disk afterwards would make the button a lie.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GoogleApi } from '../src/main/google/api'
import { openGoogleCache, type GoogleCache } from '../src/main/google/cache'
import { createGoogleData, type GoogleData } from '../src/main/google/data'
import { listAgenda } from '../src/main/google/calendar'
import { listThreads } from '../src/main/google/gmail'

const CAL_LIST = 'https://www.googleapis.com/calendar/v3/users/me/calendarList'
const WINDOW = { timeMin: '2026-08-04T00:00:00Z', timeMax: '2026-08-11T00:00:00Z' }

let dir: string
let path: string
let cache: GoogleCache
let data: GoogleData

/** A fake Google with one calendar holding one event, and one mail thread. */
function google() {
  const seen: string[] = []
  const fetchImpl = vi.fn(async (url: string) => {
    seen.push(url)
    const ok = (body: unknown) => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })
    const path_ = new URL(url).pathname

    if (url.startsWith(CAL_LIST)) {
      return ok({ items: [{ id: 'primary', summary: 'Me', accessRole: 'owner' }] })
    }
    if (path_.includes('/calendar/v3/calendars/')) {
      return ok({
        items: [
          {
            id: 'e1',
            summary: 'Stand-up',
            htmlLink: 'https://calendar.google.com/e1',
            start: { dateTime: '2026-08-04T09:00:00Z' },
            end: { dateTime: '2026-08-04T09:15:00Z' },
          },
        ],
      })
    }
    if (path_.endsWith('/labels')) return ok({ labels: [] })
    if (path_.endsWith('/profile')) return ok({ historyId: '100' })
    if (path_.endsWith('/threads')) return ok({ threads: [{ id: 't1' }] })
    if (path_.includes('/threads/')) {
      return ok({
        id: 't1',
        messages: [
          {
            id: 'm1',
            internalDate: '1000000000000',
            labelIds: ['INBOX'],
            payload: { headers: [{ name: 'Subject', value: 'Q2 budget' }] },
          },
        ],
      })
    }
    return ok({})
  }) as unknown as typeof globalThis.fetch

  return { api: () => new GoogleApi({ accessToken: async () => 'at', fetch: fetchImpl }), seen }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holi-google-data-'))
  path = join(dir, 'google-cache.db')
  cache = openGoogleCache(path)
  data = createGoogleData({ api: google().api, cache })
  data.useAccount('sub-a')
})

afterEach(async () => {
  cache.close()
  await rm(dir, { recursive: true, force: true })
})

describe('createGoogleData', () => {
  it('disconnect deletes the cached mail', async () => {
    await data.threads({})
    await data.agenda(WINDOW, {})
    expect(existsSync(path)).toBe(true)

    data.forget()

    // The one that matters. Disconnect revokes the grant and clears the
    // keychain; leaving a readable inbox on disk would make the button a lie.
    expect(existsSync(path)).toBe(false)
  })

  it('a cached agenda is served before Google answers', async () => {
    expect(data.cachedAgenda(WINDOW, {})).toBeNull()

    await data.agenda(WINDOW, {})

    // Synchronous and request-free: this is what the panel paints while the
    // live fetch is still in flight, instead of an empty day.
    const painted = data.cachedAgenda(WINDOW, {})
    expect(painted?.map((e) => e.title)).toEqual(['Stand-up'])
  })

  it('never paints one day’s agenda for another, or a changed calendar set', async () => {
    await data.agenda(WINDOW, {})

    expect(
      data.cachedAgenda({ timeMin: '2026-08-11T00:00:00Z', timeMax: '2026-08-18T00:00:00Z' }, {}),
    ).toBeNull()
    // A colleague switched on since the cache was written is a different
    // question, and the old answer does not contain their events.
    expect(data.cachedAgenda(WINDOW, { jane: true })).toBeNull()
  })

  it('serves the second mail load from the cache, for one request', async () => {
    const g = google()
    const cached = createGoogleData({ api: g.api, cache })
    cached.useAccount('sub-a')
    await cached.threads({})
    const before = g.seen.length

    await cached.threads({})

    // threads.list + threads.get + labels + profile, then a single
    // history.list. This is the twenty-six-to-one the whole phase is for.
    expect(g.seen.length - before).toBe(1)
    expect(g.seen[before]).toContain('/history')
  })

  it('the agent’s ops server never reads the cache', async () => {
    const g = google()
    // Exactly what `main/index.ts` hands `createGoogleOpsServer`: the raw
    // functions. They take no cache parameter, so the exclusion is structural
    // rather than a rule someone has to keep remembering.
    await listAgenda(g.api(), WINDOW, { overrides: {} })
    await listThreads(g.api(), {})

    // The agent asks for current data (D67, "Do not cache"); nothing it did
    // touched the store, so nothing it reads can be stale.
    expect(cache.readAgenda('')).toBeNull()
    expect(cache.readThreads('')).toBeNull()
    expect(existsSync(path)).toBe(true)
  })
})
