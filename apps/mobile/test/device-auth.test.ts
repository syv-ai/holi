import { describe, expect, it } from 'vitest'
import { authorizeWithGitHub, createCancellation, type DeviceAuthHttp } from '../app/device-auth'

const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
const device = {
  device_code: 'private-code',
  user_code: 'ABCD',
  verification_uri: 'https://github.com/login/device',
  expires_in: 60,
  interval: 1,
}

function protocol(polls: unknown[], urls: string[] = []): DeviceAuthHttp {
  let count = 0
  return async (url, init) => {
    urls.push(url)
    expect(init.method).toBe('POST')
    expect(init.headers.Accept).toBe('application/json')
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    const body = new URLSearchParams(init.body)
    expect(body.get('client_id')).toBe('public-id')
    expect(body.get('scope')).toBe(count === 0 ? 'repo' : null)
    expect(body.get('device_code')).toBe(count === 0 ? null : device.device_code)
    expect(body.get('grant_type')).toBe(
      count === 0 ? null : 'urn:ietf:params:oauth:grant-type:device_code',
    )
    count++
    return response(count === 1 ? device : polls.shift())
  }
}

describe('authorizeWithGitHub', () => {
  it('returns the granted token after pending and slow-down responses', async () => {
    let time = 0
    const delays: number[] = []
    const urls: string[] = []
    const session = await authorizeWithGitHub({
      clientId: 'public-id',
      fetch: protocol(
        [
          { error: 'authorization_pending' },
          { error: 'slow_down' },
          { access_token: 'secret-token' },
        ],
        urls,
      ),
      now: () => time,
      wait: async (ms) => {
        time += ms
        delays.push(ms)
      },
    })
    expect(session).toMatchObject({
      userCode: 'ABCD',
      verificationUri: device.verification_uri,
      expiresIn: 60,
    })
    const result = await session.wait()
    expect(result).toBe('secret-token')
    expect(delays).toEqual([1000, 1000, 6000])
    expect(urls).toEqual([
      'https://github.com/login/device/code',
      'https://github.com/login/oauth/access_token',
      'https://github.com/login/oauth/access_token',
      'https://github.com/login/oauth/access_token',
    ])
  })

  it.each([{ error: 'access_denied' }, { error: 'expired_token' }])(
    'reports protocol termination without response details',
    async (poll) => {
      const session = await authorizeWithGitHub({
        clientId: 'public-id',
        fetch: protocol([poll]),
        wait: async () => {},
      })
      await expect(session.wait()).rejects.toThrow(/denied|expired/)
    },
  )

  it('expires without polling at the deadline', async () => {
    let time = 0
    let requests = 0
    const session = await authorizeWithGitHub({
      clientId: 'public-id',
      fetch: async () => {
        requests++
        return response(device)
      },
      now: () => time,
      wait: async () => {
        time = 60_000
      },
    })
    await expect(session.wait()).rejects.toThrow('expired')
    expect(requests).toBe(1)
  })

  it('cancels during the wait before polling', async () => {
    const cancellation = createCancellation()
    let release!: () => void
    const waiting = new Promise<void>((resolve) => (release = resolve))
    const session = await authorizeWithGitHub({
      clientId: 'public-id',
      fetch: protocol([{ access_token: 'late-token' }]),
      signal: cancellation.signal,
      wait: async () => waiting,
    })
    const pending = session.wait()
    cancellation.abort()
    release()
    await expect(pending).rejects.toThrow('cancelled')
  })

  it('cancels an in-flight HTTP request without accepting a token', async () => {
    const cancellation = createCancellation()
    let listenerRegistered!: () => void
    const registered = new Promise<void>((resolve) => (listenerRegistered = resolve))
    const session = await authorizeWithGitHub({
      clientId: 'public-id',
      fetch: async (_url, init) => {
        if (init.body.includes('device_code='))
          return new Promise((_resolve, reject) => {
            if (init.signal.aborted) return reject(new Error('cancelled'))
            init.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
              once: true,
            })
            listenerRegistered()
          })
        return response(device)
      },
      signal: cancellation.signal,
      wait: async () => {},
    })
    const pending = session.wait()
    await registered
    cancellation.abort()
    await expect(pending).rejects.toThrow('cancelled')
  })

  it('rejects HTTP and malformed response failures without exposing response bodies', async () => {
    const http: DeviceAuthHttp = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ secret: 'do not expose' }),
    })
    await expect(authorizeWithGitHub({ clientId: 'public-id', fetch: http })).rejects.toThrow('401')
    const malformed: DeviceAuthHttp = async () =>
      response({ error_description: 'sensitive response' })
    await expect(
      authorizeWithGitHub({ clientId: 'public-id', fetch: malformed }),
    ).rejects.not.toThrow('sensitive response')
  })
})
