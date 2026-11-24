import { describe, expect, it } from 'vitest'
import { authorizeWithGitHub, type DeviceAuthHttp } from '../app/device-auth'

const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
const device = {
  device_code: 'private-code',
  user_code: 'ABCD',
  verification_uri: 'https://github.com/login/device',
  expires_in: 60,
  interval: 1,
}

function protocol(polls: unknown[]): DeviceAuthHttp {
  let count = 0
  return async (_url, init) => {
    expect(init.headers.Accept).toBe('application/json')
    return response(count++ === 0 ? device : polls.shift())
  }
}

describe('authorizeWithGitHub', () => {
  it('returns the granted token after pending and slow-down responses', async () => {
    const delays: number[] = []
    const session = await authorizeWithGitHub({
      clientId: 'public-id',
      fetch: protocol([
        { error: 'authorization_pending' },
        { error: 'slow_down' },
        { access_token: 'secret-token' },
      ]),
      wait: async (ms) => {
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
  })

  it.each([{ error: 'access_denied' }, { error: 'expired_token' }])(
    'reports protocol termination without response details',
    async (poll) => {
      await expect(
        authorizeWithGitHub({
          clientId: 'public-id',
          fetch: protocol([poll]),
          wait: async () => {},
        }),
      ).rejects.toThrow(/denied|expired/)
    },
  )

  it('cancels an in-flight HTTP request without accepting a token', async () => {
    const controller = new AbortController()
    const session = await authorizeWithGitHub({
      clientId: 'public-id',
      fetch: async (_url, init) => {
        if (init.body.includes('device_code='))
          return new Promise((_resolve, reject) =>
            init.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
              once: true,
            }),
          )
        return response(device)
      },
      signal: controller.signal,
      wait: async () => {},
    })
    const pending = session.wait()
    controller.abort()
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
