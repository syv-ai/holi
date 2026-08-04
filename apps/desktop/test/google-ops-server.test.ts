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
