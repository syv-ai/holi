import { describe, expect, it } from 'vitest'
import { startDeviceFlow } from '../src/main/github/device-flow'

/** A recorded request, in the shape the assertions want to read it. */
interface Recorded {
  url: string
  method: string
  headers: Record<string, string>
  /** The form body, already parsed — every request this module makes has one. */
  params: Record<string, string>
}

interface Scripted {
  status?: number
  body: unknown
}

/**
 * A scripted `fetch`.
 *
 * Responses are handed out in order; once the script is exhausted the **last
 * entry repeats**, so a test about the expiry deadline does not have to script
 * 180 identical `authorization_pending` replies to reach it.
 */
function fakeFetch(script: Scripted[]) {
  const requests: Recorded[] = []
  let i = 0

  const fetch = (async (input: unknown, init?: RequestInit) => {
    const raw = typeof init?.body === 'string' ? init.body : ''
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      params: Object.fromEntries(new URLSearchParams(raw)),
    })
    const next = script[Math.min(i++, script.length - 1)]
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof globalThis.fetch

  return { fetch, requests }
}

/** A clock that only moves when the flow sleeps — so an expiry test is instant. */
function clock(start = 1_000_000) {
  let t = start
  const sleeps: number[] = []
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      t += ms
    },
  }
}

const CODE = {
  device_code: '3584d83530557fdd1f46af8289938c8ef79f9dc5',
  user_code: 'WDJB-MJHT',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5,
}

const GRANT = {
  access_token: 'gho_16C7e42F292c6912E7710c838347Ae178B4a',
  token_type: 'bearer',
  scope: 'repo,read:user,read:org',
}

/** HTTP **200** with an `error` field — the shape that makes `res.ok` a trap. */
const PENDING = { error: 'authorization_pending', error_description: 'Pending user auth' }

const SCOPES = ['repo', 'read:user', 'read:org']

function start(script: Scripted[], over: Partial<Parameters<typeof startDeviceFlow>[0]> = {}) {
  const net = fakeFetch(script)
  const c = clock()
  const flow = startDeviceFlow({
    clientId: 'Iv1.test0client0id',
    scopes: SCOPES,
    fetch: net.fetch,
    now: c.now,
    sleep: c.sleep,
    ...over,
  })
  return { flow, ...net, ...c }
}

describe('startDeviceFlow', () => {
  it('requests a device code with the client id and scopes', async () => {
    const t = start([{ body: CODE }])
    await t.flow

    expect(t.requests).toHaveLength(1)
    const req = t.requests[0]
    expect(req.url).toBe('https://github.com/login/device/code')
    expect(req.method).toBe('POST')
    // Without this header GitHub replies form-urlencoded and res.json() throws
    // on a response that was actually fine.
    expect(req.headers.Accept).toBe('application/json')
    expect(req.params.client_id).toBe('Iv1.test0client0id')
    expect(req.params.scope).toBe('repo read:user read:org')
  })

  it('returns the user code and verification uri without polling yet', async () => {
    // FR-2's whole point: the code must be displayable before the grant exists.
    // A one-shot signIn() could not surface it until it was already spent.
    const t = start([{ body: CODE }])
    const flow = await t.flow

    expect(flow.code.userCode).toBe('WDJB-MJHT')
    expect(flow.code.verificationUri).toBe('https://github.com/login/device')
    expect(t.requests).toHaveLength(1)
  })

  it('computes expiresAt from expires_in and now()', async () => {
    const flow = await start([{ body: CODE }]).flow
    expect(flow.code.expiresAt).toBe(1_000_000 + 900_000)
  })

  it('polls until the token arrives', async () => {
    const t = start([{ body: CODE }, { body: PENDING }, { body: PENDING }, { body: GRANT }])
    const flow = await t.flow

    expect(await flow.wait()).toEqual({
      kind: 'granted',
      token: GRANT.access_token,
      // GitHub returns `scope` as one comma-separated string, not an array.
      scopes: ['repo', 'read:user', 'read:org'],
    })
    expect(t.requests).toHaveLength(4)
    expect(t.requests[1].url).toBe('https://github.com/login/oauth/access_token')
    expect(t.requests[1].params.grant_type).toBe('urn:ietf:params:oauth:grant-type:device_code')
    expect(t.requests[1].params.device_code).toBe(CODE.device_code)
  })

  it('waits the returned interval between polls', async () => {
    const t = start([{ body: CODE }, { body: PENDING }, { body: GRANT }])
    await (await t.flow).wait()

    // Seconds on the wire, milliseconds to sleep(). Getting this wrong polls
    // 1000x too fast and GitHub rate-limits the flow out entirely.
    expect(t.sleeps).toEqual([5000, 5000])
  })

  it('backs off on slow_down and adopts the new interval', async () => {
    const t = start([
      { body: CODE },
      { body: { error: 'slow_down', interval: 10 } },
      { body: PENDING },
      { body: GRANT },
    ])
    await (await t.flow).wait()

    expect(t.sleeps).toEqual([5000, 10_000, 10_000])
  })

  it('adds five seconds when slow_down carries no interval', async () => {
    const t = start([{ body: CODE }, { body: { error: 'slow_down' } }, { body: GRANT }])
    await (await t.flow).wait()

    expect(t.sleeps).toEqual([5000, 10_000])
  })

  it('returns denied on access_denied', async () => {
    // A user pressing Cancel on github.com is a normal outcome, not a throw.
    const t = start([{ body: CODE }, { body: { error: 'access_denied' } }])
    expect(await (await t.flow).wait()).toEqual({ kind: 'denied' })
  })

  it('returns expired on expired_token', async () => {
    const t = start([{ body: CODE }, { body: { error: 'expired_token' } }])
    expect(await (await t.flow).wait()).toEqual({ kind: 'expired' })
  })

  it('returns expired when the deadline passes without a verdict', async () => {
    // The script's last entry repeats, so this polls until the clock runs out.
    // A poller with no deadline holds a request loop alive for the life of the
    // process.
    const t = start([{ body: CODE }, { body: PENDING }])
    expect(await (await t.flow).wait()).toEqual({ kind: 'expired' })

    // 900s at 5s intervals: it stopped rather than looping forever.
    expect(t.requests.length).toBeLessThanOrEqual(181)
  })

  it('returns cancelled and stops polling after cancel()', async () => {
    // The request count is the assertion. A resolved promise over a still-live
    // loop passes a weaker test, and the live loop is what burns the rate limit.
    const t = start([{ body: CODE }, { body: PENDING }])
    const flow = await t.flow

    const before = t.requests.length
    flow.cancel()

    expect(await flow.wait()).toEqual({ kind: 'cancelled' })
    expect(t.requests).toHaveLength(before)
  })

  it('stops polling when cancelled mid-flight', async () => {
    const net = fakeFetch([{ body: CODE }, { body: PENDING }])
    const c = clock()
    let flow: Awaited<ReturnType<typeof startDeviceFlow>>

    const sleep = async (ms: number) => {
      await c.sleep(ms)
      flow.cancel()
    }

    flow = await startDeviceFlow({
      clientId: 'Iv1.test0client0id',
      scopes: SCOPES,
      fetch: net.fetch,
      now: c.now,
      sleep,
    })

    expect(await flow.wait()).toEqual({ kind: 'cancelled' })
    expect(net.requests).toHaveLength(1)
  })

  it('surfaces a 404 on the device-code endpoint as advice', async () => {
    // This is what an OAuth app without the device-flow checkbox looks like,
    // and it reads exactly like a wrong URL.
    const t = start([{ status: 404, body: { message: 'Not Found' } }])
    await expect(t.flow).rejects.toThrow(/device flow/i)
  })

  it('throws on an unrecognised grant error rather than guessing', async () => {
    const t = start([{ body: CODE }, { body: { error: 'incorrect_client_credentials' } }])
    await expect((await t.flow).wait()).rejects.toThrow(/incorrect_client_credentials/)
  })
})
