/**
 * The agent's door to Google.
 *
 * The property under test is the one that makes the whole "no MCP" decision
 * safe: this server hands back **results**, and there is no route, header, or
 * error path that yields a Google token. Plus the token guard, because an
 * ephemeral port is not a boundary.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGoogleOpsServer, type GoogleOps } from '../src/main/google/ops-server'

let stop: (() => Promise<void>) | null = null

afterEach(async () => {
  await stop?.()
  stop = null
})

async function serve(ops: Partial<GoogleOps> = {}) {
  const server = createGoogleOpsServer({
    agenda: vi.fn(async () => [{ id: 'e1', title: 'Q2 review' }]),
    threads: vi.fn(async () => [{ id: 't1', subject: 'Budget' }]),
    thread: vi.fn(async () => ({ id: 't1', messages: [] })),
    setRead: vi.fn(async () => {}),
    star: vi.fn(async () => {}),
    archive: vi.fn(async () => {}),
    trash: vi.fn(async () => {}),
    draft: vi.fn(async () => ({ id: 'd-1' })),
    send: vi.fn(async () => ({ id: 'm-1' })),
    reply: vi.fn(async () => ({ id: 'm-2' })),
    schedule: vi.fn(async () => ({ id: 'ev-1' })),
    reschedule: vi.fn(async () => {}),
    unschedule: vi.fn(async () => {}),
    ...ops,
  })
  await server.start()
  stop = server.stop
  const base = `http://127.0.0.1:${server.port()}`
  return { server, base, url: (p: string) => `${base}${p}?t=${server.token()}` }
}

describe('auth', () => {
  it('refuses a request with no token', async () => {
    const { base } = await serve()
    expect((await fetch(`${base}/agenda`)).status).toBe(403)
  })

  it('refuses a request with the wrong token', async () => {
    const { base } = await serve()
    expect((await fetch(`${base}/agenda?t=nope`)).status).toBe(403)
  })

  it('binds a fresh token per instance', async () => {
    const a = createGoogleOpsServer({} as GoogleOps)
    const b = createGoogleOpsServer({} as GoogleOps)
    expect(a.token()).not.toBe(b.token())
  })
})

describe('routes', () => {
  it('serves the agenda, defaulting to a week when no window is given', async () => {
    const agenda = vi.fn(async () => [])
    const { url } = await serve({ agenda })

    await fetch(url('/agenda'))

    const [{ timeMin, timeMax }] = agenda.mock.calls[0] as [{ timeMin: string; timeMax: string }]
    expect(Date.parse(timeMax) - Date.parse(timeMin)).toBe(7 * 86_400_000)
  })

  it('passes an explicit window through', async () => {
    const agenda = vi.fn(async () => [])
    const { url } = await serve({ agenda })

    await fetch(`${url('/agenda')}&timeMin=2026-08-04T00:00:00.000Z&timeMax=2026-08-05T00:00:00.000Z`)

    expect(agenda).toHaveBeenCalledWith({
      timeMin: '2026-08-04T00:00:00.000Z',
      timeMax: '2026-08-05T00:00:00.000Z',
    })
  })

  it('searches mail with the caller’s query', async () => {
    const threads = vi.fn(async () => [])
    const { url } = await serve({ threads })

    await fetch(`${url('/threads')}&q=${encodeURIComponent('from:jane is:unread')}`)

    expect(threads).toHaveBeenCalledWith('from:jane is:unread')
  })

  it('reads a thread by id, and refuses without one', async () => {
    const thread = vi.fn(async () => ({}))
    const { url } = await serve({ thread })

    await fetch(`${url('/thread')}&id=t1`)
    expect(thread).toHaveBeenCalledWith('t1')

    expect((await fetch(url('/thread'))).status).toBe(502)
  })

  it('404s an unknown operation rather than guessing', async () => {
    const { url } = await serve()
    expect((await fetch(url('/send'))).status).toBe(404)
  })
})

describe('failures', () => {
  it('reports the underlying message, so the agent can act on it', async () => {
    const { url } = await serve({
      agenda: async () => {
        throw new Error('the Google connection has expired — connect Google again')
      },
    })

    const res = await fetch(url('/agenda'))

    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toMatch(/connect Google again/)
  })
})

describe('it serves results, never credentials', () => {
  it('has no route that returns a token', async () => {
    const { url, server } = await serve()

    const bodies = await Promise.all(
      ['/agenda', '/threads', '/thread'].map((p) => fetch(url(p)).then((r) => r.text())),
    )

    // The instance token authenticates the caller; it must never be echoed, and
    // no Google credential exists on this side of the wall at all.
    for (const body of bodies) expect(body).not.toContain(server.token())
    for (const body of bodies) expect(body).not.toMatch(/access_token|refresh_token|Bearer/)
  })
})

/**
 * The write half (D70).
 *
 * The agent's writes arrive as POST with a JSON body, because a mail body does
 * not belong in a query string. Everything here is either "the argument
 * survived the trip" or a refusal that has to be distinguishable from the
 * others: the agent reads these status codes and has to be able to tell a
 * malformed request of its own from Google being unreachable.
 */
describe('writes', () => {
  async function post(url: string, body: unknown, init: RequestInit = {}) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...init,
    })
  }

  it('marks read and unread through the same route', async () => {
    const setRead = vi.fn(async () => {})
    const { url } = await serve({ setRead })

    await post(url('/mark-read'), { id: 't1', read: true })
    await post(url('/mark-read'), { id: 't1', read: false })

    expect(setRead.mock.calls).toEqual([
      ['t1', true],
      ['t1', false],
    ])
  })

  it('stars in both directions', async () => {
    const star = vi.fn(async () => {})
    const { url } = await serve({ star })

    await post(url('/star'), { id: 't1', on: false })

    expect(star).toHaveBeenCalledWith('t1', false)
  })

  it('archives and trashes by id', async () => {
    const archive = vi.fn(async () => {})
    const trash = vi.fn(async () => {})
    const { url } = await serve({ archive, trash })

    await post(url('/archive'), { id: 't1' })
    await post(url('/trash'), { id: 't2' })

    expect(archive).toHaveBeenCalledWith('t1')
    expect(trash).toHaveBeenCalledWith('t2')
  })

  it('carries a multi-line body through to send, intact', async () => {
    const send = vi.fn(async () => ({ id: 'm-1' }))
    const { url } = await serve({ send })
    const body = 'Hej Ada,\n\nSe venligst vedhæftet — "Q2".\n\nMvh'

    const res = await post(url('/send'), {
      to: ['ada@syv.ai'],
      subject: 'Møde på tirsdag',
      body,
    })

    expect(send).toHaveBeenCalledWith({
      mail: expect.objectContaining({ to: ['ada@syv.ai'], subject: 'Møde på tirsdag', body }),
    })
    expect(await res.json()).toEqual({ id: 'm-1' })
  })

  it('replies by thread id', async () => {
    const reply = vi.fn(async () => ({ id: 'm-2' }))
    const { url } = await serve({ reply })

    await post(url('/reply'), { threadId: 't1', body: 'Yes.' })

    // Reply to the sender by default; reply-all has to be asked for, because
    // the confirmation prompt cannot show a recipient list it never saw.
    expect(reply).toHaveBeenCalledWith('t1', 'Yes.', false)

    await post(url('/reply'), { threadId: 't1', body: 'Yes.', all: true })
    expect(reply).toHaveBeenLastCalledWith('t1', 'Yes.', true)
  })

  it('drafts, passing the thread through when there is one', async () => {
    const draft = vi.fn(async () => ({ id: 'd-1' }))
    const { url } = await serve({ draft })

    await post(url('/draft'), { to: ['ada@syv.ai'], subject: 'x', body: 'y', threadId: 't1' })

    expect(draft).toHaveBeenCalledWith(expect.objectContaining({ threadId: 't1' }))
  })

  it('schedules, reschedules and unschedules', async () => {
    const schedule = vi.fn(async () => ({ id: 'ev-1' }))
    const reschedule = vi.fn(async () => {})
    const unschedule = vi.fn(async () => {})
    const { url } = await serve({ schedule, reschedule, unschedule })

    await post(url('/schedule'), {
      title: 'Deep work',
      start: '2026-08-06T09:00:00Z',
      end: '2026-08-06T11:00:00Z',
    })
    await post(url('/reschedule'), { id: 'ev-1', start: '2026-08-06T10:00:00Z' })
    await post(url('/unschedule'), { id: 'ev-1' })

    expect(schedule).toHaveBeenCalledWith(expect.objectContaining({ title: 'Deep work' }))
    expect(reschedule).toHaveBeenCalledWith('ev-1', expect.objectContaining({ start: '2026-08-06T10:00:00Z' }))
    expect(unschedule).toHaveBeenCalledWith('ev-1')
  })

  it('refuses an untokened POST without parsing its body', async () => {
    // The order matters: parsing first would mean an unauthenticated caller
    // could hand this process arbitrary JSON to chew on.
    const send = vi.fn(async () => ({ id: 'm-1' }))
    const { base } = await serve({ send })

    const res = await post(`${base}/send`, { to: ['ada@syv.ai'] })

    expect(res.status).toBe(403)
    expect(send).not.toHaveBeenCalled()
  })

  it('answers 400 for a malformed body — not the 502 that means Google failed', async () => {
    // The agent reads these apart: 400 is "fix your request", 502 is "Google
    // is unreachable, try later". Collapsing them makes it retry the wrong one.
    const { url } = await serve()

    const res = await fetch(url('/send'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ this is not json',
    })

    expect(res.status).toBe(400)
  })

  it('refuses an oversized body rather than accumulating it', async () => {
    const { url } = await serve()

    const res = await fetch(url('/send'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'x'.repeat(2 * 1024 * 1024) }),
    })

    expect(res.status).toBe(413)
  })

  it('404s an unknown POST path, exactly as it does for GET', async () => {
    const { url } = await serve()

    expect((await post(url('/delete-everything'), {})).status).toBe(404)
  })

  it('reports a refusal from Google as 502, with the reason the agent should read', async () => {
    const { url } = await serve({
      unschedule: vi.fn(async () => {
        throw new Error('"Q2 review" has attendees, so changing it would email them.')
      }),
    })

    const res = await post(url('/unschedule'), { id: 'ev-2' })

    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/attendees/)
  })
  /**
   * Sending a draft that already exists (D70, amended 2026-08-14).
   *
   * `draft` then a composed `send` produced TWO messages and orphaned the draft —
   * found against a real account, after the agent had done exactly that.
   */
  describe('send --draft', () => {
    it('sends the draft by id, composing nothing', async () => {
      const send = vi.fn(async () => ({ id: 'm-sent' }))
      const { url } = await serve({ send })

      const res = await post(url('/send'), { draftId: 'd-1' })

      expect(send).toHaveBeenCalledWith({ draftId: 'd-1' })
      expect(await res.json()).toEqual({ id: 'm-sent' })
    })

    it('prefers the draft over any composed fields that came with it', async () => {
      // Alternatives, not a merge. A draft already carries its recipients,
      // subject and threading headers, and taking half from each is how a send
      // goes somewhere nobody chose.
      const send = vi.fn(async () => ({ id: 'm-sent' }))
      const { url } = await serve({ send })

      await post(url('/send'), { draftId: 'd-1', to: ['eve@evil.example'], subject: 'x', body: 'y' })

      expect(send).toHaveBeenCalledWith({ draftId: 'd-1' })
    })

    it('still composes when no draftId is given', async () => {
      const send = vi.fn(async () => ({ id: 'm-1' }))
      const { url } = await serve({ send })

      await post(url('/send'), { to: ['ada@syv.ai'], subject: 's', body: 'b' })

      expect(send).toHaveBeenCalledWith({ mail: expect.objectContaining({ to: ['ada@syv.ai'] }) })
    })

    it('treats an empty draftId as absent rather than sending nothing', async () => {
      const send = vi.fn(async () => ({ id: 'm-1' }))
      const { url } = await serve({ send })

      const res = await post(url('/send'), { draftId: '', to: ['ada@syv.ai'], subject: 's', body: 'b' })

      expect(res.status).toBe(200)
      expect(send).toHaveBeenCalledWith({ mail: expect.objectContaining({ to: ['ada@syv.ai'] }) })
    })
  })

})
