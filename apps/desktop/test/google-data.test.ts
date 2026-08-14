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
/** `cacheKey({})` — query, category and the unread filter, all empty. */
const INBOX_KEY = '||'

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

  /**
   * The address book is fetched once, not once per mount.
   *
   * `MailView` asks on every mount, and the People API is paged — so without a
   * hold, opening and closing the mail tab three times spent a dozen requests
   * against a rate-limited API to populate a dropdown. An address book is also
   * the least time-sensitive thing this connector holds: a contact saved today
   * is not why completion missed someone.
   */
  describe('contacts', () => {
    /** A People API that counts how many times it was actually asked. */
    function peopleApi() {
      let calls = 0
      const fetchImpl = vi.fn(async (url: string) => {
        calls++
        const body = url.includes('otherContacts')
          ? { otherContacts: [] }
          : { connections: [{ names: [{ displayName: 'Jane' }], emailAddresses: [{ value: 'jane@syv.ai' }] }] }
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
      }) as unknown as typeof globalThis.fetch
      const subject = createGoogleData({
        api: () => new GoogleApi({ accessToken: async () => 'at', fetch: fetchImpl }),
        cache,
      })
      return { data: subject, calls: () => calls }
    }

    it('is fetched once however many times it is asked for', async () => {
      const { data: subject, calls } = peopleApi()
      subject.useAccount('sub-a')

      const first = await subject.contacts()
      const second = await subject.contacts()

      expect(first).toEqual([{ name: 'Jane', email: 'jane@syv.ai' }])
      expect(second).toEqual(first)
      // Two collections, one round. A second `contacts()` costs nothing.
      expect(calls()).toBe(2)
    })

    it('two callers racing produce one fetch, not two', async () => {
      // A promise is held rather than a value precisely for this: two messages
      // mounting together used to be two round trips.
      const { data: subject, calls } = peopleApi()
      subject.useAccount('sub-a')

      await Promise.all([subject.contacts(), subject.contacts()])

      expect(calls()).toBe(2)
    })

    it('is dropped when the account changes', async () => {
      // Unlike the cached mail it is not keyed by account, so nothing else
      // would stop one account completing to another's contacts.
      const { data: subject, calls } = peopleApi()
      subject.useAccount('sub-a')
      await subject.contacts()

      subject.useAccount('sub-b')
      await subject.contacts()

      expect(calls()).toBe(4)
    })

    it('is dropped on disconnect', async () => {
      const { data: subject, calls } = peopleApi()
      subject.useAccount('sub-a')
      await subject.contacts()

      subject.forget()
      await subject.contacts()

      expect(calls()).toBe(4)
    })
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

/**
 * The writes (D68), and the ordering that keeps disk honest.
 *
 * **Google first, cache only on success.** Patching optimistically and then
 * discovering the request failed leaves a lie on disk that survives a restart —
 * and it is the one divergence a delta sync cannot repair, because from Gmail's
 * side nothing ever changed and `history.list` has nothing to report.
 */
describe('mutations', () => {
  /** A Gmail whose reads work and whose writes can be told to fail. */
  function mutable({ writesFail = false } = {}) {
    const posts: string[] = []
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const ok = (body: unknown) => ({
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      })
      if (init?.method === 'POST') {
        posts.push(url)
        if (writesFail) {
          return {
            ok: false,
            status: 403,
            json: async () => ({}),
            text: async () =>
              JSON.stringify({ error: { errors: [{ reason: 'insufficientPermissions' }] } }),
          }
        }
        return ok({})
      }
      const path_ = new URL(url).pathname
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
              // Unread and unstarred, so every write below has somewhere to go.
              labelIds: ['INBOX', 'UNREAD'],
              payload: { headers: [{ name: 'Subject', value: 'Q2 budget' }] },
            },
          ],
        })
      }
      return ok({})
    }) as unknown as typeof globalThis.fetch

    const subject = createGoogleData({
      api: () => new GoogleApi({ accessToken: async () => 'at', fetch: fetchImpl }),
      cache,
    })
    subject.useAccount('sub-a')
    return { data: subject, posts }
  }

  it('marks read at Google and clears the cached flag', async () => {
    const { data: subject, posts } = mutable()
    expect((await subject.threads({})).threads[0]!.unread).toBe(true)

    await subject.setRead('t1', true)

    expect(posts).toEqual([
      'https://gmail.googleapis.com/gmail/v1/users/me/threads/t1/modify',
    ])
    expect(cache.readThreads(INBOX_KEY)![0]!.unread).toBe(false)
  })

  it('marks unread again, and the cached flag comes back', async () => {
    const { data: subject, posts } = mutable()
    await subject.threads({})
    await subject.setRead('t1', true)

    await subject.setRead('t1', false)

    expect(posts).toHaveLength(2)
    expect(cache.readThreads(INBOX_KEY)![0]!.unread).toBe(true)
  })

  it('leaves the cache untouched when Google refuses, and rethrows', async () => {
    const { data: subject } = mutable({ writesFail: true })
    await subject.threads({})

    await expect(subject.setRead('t1', true)).rejects.toThrow()

    // Still unread on disk. A cache that recorded a write Google refused is a
    // divergence no later sync can find.
    expect(cache.readThreads(INBOX_KEY)![0]!.unread).toBe(true)
  })

  it('stars in both directions', async () => {
    const { data: subject } = mutable()
    await subject.threads({})

    await subject.setStarred('t1', true)
    expect(cache.readThreads(INBOX_KEY)![0]!.starred).toBe(true)

    await subject.setStarred('t1', false)
    expect(cache.readThreads(INBOX_KEY)![0]!.starred).toBe(false)
  })

  it('archive and trash remove the thread from the cached list', async () => {
    const { data: subject } = mutable()
    await subject.threads({})
    expect(cache.readThreads(INBOX_KEY)).toHaveLength(1)

    await subject.archive('t1')
    expect(cache.readThreads(INBOX_KEY)).toHaveLength(0)
  })

  it('a refused archive leaves the thread in the list', async () => {
    const { data: subject } = mutable({ writesFail: true })
    await subject.threads({})

    await expect(subject.archive('t1')).rejects.toThrow()

    expect(cache.readThreads(INBOX_KEY)).toHaveLength(1)
  })
})

/**
 * The composer's writes (D71).
 *
 * §7 earns itself here. A sent *message* is not a label delta and `patchThread`
 * cannot express one — but a draft appearing and disappearing **is** one, which
 * is what makes the thread's *Continue draft* chip arrive and leave without a
 * refetch.
 */
describe('composer writes', () => {
  /** A Gmail that records what was asked of it and can be told to refuse. */
  function composer({ writesFail = false } = {}) {
    const calls: { method: string; url: string }[] = []
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const ok = (body: unknown) => ({
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      })
      const method = init?.method ?? 'GET'
      const path_ = new URL(url).pathname

      if (method !== 'GET') {
        calls.push({ method, url })
        if (writesFail) {
          return {
            ok: false,
            status: 403,
            json: async () => ({}),
            text: async () =>
              JSON.stringify({ error: { errors: [{ reason: 'insufficientPermissions' }] } }),
          }
        }
        return ok({ id: 'x-1' })
      }

      calls.push({ method, url })
      if (path_.endsWith('/settings/sendAs')) {
        if (writesFail) {
          return {
            ok: false,
            status: 403,
            json: async () => ({}),
            text: async () =>
              JSON.stringify({ error: { errors: [{ reason: 'insufficientPermissions' }] } }),
          }
        }
        return ok({ sendAs: [{ sendAsEmail: 'Ada@syv.ai', isDefault: true }] })
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
              payload: {
                headers: [
                  { name: 'Subject', value: 'Q2 budget' },
                  { name: 'Message-ID', value: '<msg-1@mail.example>' },
                ],
              },
            },
          ],
        })
      }
      return ok({})
    }) as unknown as typeof globalThis.fetch

    const subject = createGoogleData({
      api: () => new GoogleApi({ accessToken: async () => 'at', fetch: fetchImpl }),
      cache,
    })
    subject.useAccount('sub-a')
    return { data: subject, calls }
  }

  const MAIL = { to: ['bo@example.com'], subject: 'Q2 budget', body: 'Here it is.' }

  it('a saved draft makes the thread show one, without a refetch', async () => {
    const { data: subject } = composer()
    expect((await subject.threads({})).threads[0]!.hasDraft).toBe(false)

    await subject.saveDraft({ mail: MAIL, threadId: 't1' })

    expect((await subject.threads({})).threads[0]!.hasDraft).toBe(true)
  })

  it('sending clears the thread’s draft flag', async () => {
    const { data: subject } = composer()
    await subject.saveDraft({ mail: MAIL, threadId: 't1' })

    await subject.sendMail({ mail: MAIL, draftId: 'd-1', threadId: 't1' })

    expect((await subject.threads({})).threads[0]!.hasDraft).toBe(false)
  })

  it('discarding clears it too', async () => {
    const { data: subject } = composer()
    await subject.saveDraft({ mail: MAIL, threadId: 't1' })

    await subject.discardDraft({ draftId: 'd-1', threadId: 't1' })

    expect((await subject.threads({})).threads[0]!.hasDraft).toBe(false)
  })

  it('does not record a draft Google refused', async () => {
    // The ordering the whole module exists for. A cache that records a write
    // Google refused is the one divergence a delta sync can never repair.
    const { data: subject } = composer({ writesFail: true })

    await expect(subject.saveDraft({ mail: MAIL, threadId: 't1' })).rejects.toMatchObject({
      code: 'scope',
    })

    expect((await subject.threads({})).threads[0]!.hasDraft).toBe(false)
  })

  it('sends a draft through drafts/send, a thread through messages/send', async () => {
    const { data: subject, calls } = composer()

    await subject.sendMail({ mail: MAIL, draftId: 'd-1', threadId: 't1' })
    expect(calls.some((c) => c.url.endsWith('/drafts/send'))).toBe(true)

    calls.length = 0
    await subject.sendMail({ mail: MAIL, threadId: 't1' })
    expect(calls.some((c) => c.url.endsWith('/messages/send'))).toBe(true)

    calls.length = 0
    await subject.sendMail({ mail: MAIL })
    expect(calls.some((c) => c.url.endsWith('/messages/send'))).toBe(true)
    expect(calls.some((c) => c.url.includes('/threads/'))).toBe(false)
  })

  it('leaves the cache alone for a message that belongs to no thread', async () => {
    const { data: subject } = composer()

    await expect(subject.sendMail({ mail: MAIL })).resolves.toEqual({ id: 'x-1' })
  })

  describe('sendAs', () => {
    it('fetches once for two callers, like the address book', async () => {
      const { data: subject, calls } = composer()

      const [a, b] = await Promise.all([subject.sendAs(), subject.sendAs()])

      expect(a).toEqual(['ada@syv.ai'])
      expect(b).toEqual(['ada@syv.ai'])
      expect(calls.filter((c) => c.url.endsWith('/settings/sendAs'))).toHaveLength(1)
    })

    it('refetches for a different account', async () => {
      const { data: subject, calls } = composer()
      await subject.sendAs()

      subject.useAccount('sub-b')
      await subject.sendAs()

      expect(calls.filter((c) => c.url.endsWith('/settings/sendAs'))).toHaveLength(2)
    })

    it('does not latch a failure, unlike the address book', async () => {
      // `listContacts` never rejects, so `contacts()` can memoise safely. This
      // one can reject, and a memoised rejection would keep every reply-all
      // copying the user on their own messages until the account changed.
      const failing = composer({ writesFail: true })
      await expect(failing.data.sendAs()).rejects.toMatchObject({ code: 'scope' })

      await expect(failing.data.sendAs()).rejects.toMatchObject({ code: 'scope' })

      expect(failing.calls.filter((c) => c.url.endsWith('/settings/sendAs'))).toHaveLength(2)
    })
  })
})

/**
 * Forwarding attachments through the write surface (D71).
 *
 * The renderer names a message; main fetches the bytes. These assert that the
 * fetch happens on the write path and that the empty case stays empty.
 */
describe('forwarded attachments', () => {
  function forwarding(attachmentCount: number) {
    const urls: string[] = []
    const sent: Record<string, unknown>[] = []
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const ok = (body: unknown) => ({
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      })
      urls.push(url)
      const path_ = new URL(url).pathname

      if (init?.method === 'POST') {
        sent.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return ok({ id: 'm-1' })
      }
      if (path_.includes('/attachments/')) return ok({ data: 'AAEC', size: 3 })
      if (path_.includes('/messages/')) {
        return ok({
          id: 'src-1',
          payload: {
            parts: Array.from({ length: attachmentCount }, (_, i) => ({
              filename: `f${i}.pdf`,
              mimeType: 'application/pdf',
              body: { attachmentId: `a${i}`, size: 3 },
            })),
          },
        })
      }
      if (path_.endsWith('/labels')) return ok({ labels: [] })
      if (path_.endsWith('/profile')) return ok({ historyId: '100' })
      return ok({})
    }) as unknown as typeof globalThis.fetch

    const subject = createGoogleData({
      api: () => new GoogleApi({ accessToken: async () => 'at', fetch: fetchImpl }),
      cache,
    })
    subject.useAccount('sub-a')
    return { data: subject, urls, sent }
  }

  const MAIL = { to: ['bo@example.com'], subject: 'Fwd: Q2', body: 'See below.' }

  it('fetches the original’s bytes in main, never across the IPC seam', async () => {
    const { data: subject, urls, sent } = forwarding(1)

    await subject.sendMail({ mail: MAIL, forwardOf: { messageId: 'src-1' } })

    expect(urls.some((url) => url.includes('/attachments/a0'))).toBe(true)
    const raw = Buffer.from(String(sent[0]!.raw), 'base64url').toString('utf8')
    expect(raw).toContain('multipart/mixed')
    expect(raw).toContain('filename="f0.pdf"')
  })

  it('takes the alternative path when the original had no attachments', async () => {
    // An empty multipart/mixed displays as a message with a mysteriously
    // missing attachment.
    const { data: subject, sent } = forwarding(0)

    await subject.sendMail({
      mail: { ...MAIL, html: '<p>See below.</p>' },
      forwardOf: { messageId: 'src-1' },
    })

    const raw = Buffer.from(String(sent[0]!.raw), 'base64url').toString('utf8')
    expect(raw).toContain('multipart/alternative')
    expect(raw).not.toContain('multipart/mixed')
  })

  it('carries the attachments onto a saved draft too, not only a send', async () => {
    // A forward saved as a draft and sent later must still have its files.
    const { data: subject, sent } = forwarding(1)

    await subject.saveDraft({ mail: MAIL, forwardOf: { messageId: 'src-1' } })

    const message = sent[0]!.message as { raw: string }
    expect(Buffer.from(message.raw, 'base64url').toString('utf8')).toContain('filename="f0.pdf"')
  })
})
