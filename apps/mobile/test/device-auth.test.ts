import { describe, expect, it } from 'vitest'
import { authorizeWithGitHub, type DeviceAuthHttp } from '../app/device-auth'

const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
const device = { device_code: 'private-code', user_code: 'ABCD', verification_uri: 'https://github.com/login/device', expires_in: 60, interval: 1 }

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
    const result = await authorizeWithGitHub({ clientId: 'public-id', fetch: protocol([{ error: 'authorization_pending' }, { error: 'slow_down' }, { access_token: 'secret-token' }]), wait: async (ms) => { delays.push(ms) } })
    expect(result).toEqual({ userCode: 'ABCD', verificationUri: device.verification_uri, expiresIn: 60, token: 'secret-token' })
    expect(delays).toEqual([1000, 1000, 6000])
  })

  it.each([{ error: 'access_denied' }, { error: 'expired_token' }])('reports protocol termination without response details', async (poll) => {
    await expect(authorizeWithGitHub({ clientId: 'public-id', fetch: protocol([poll]), wait: async () => {} })).rejects.toThrow(/denied|expired/)
  })

  it('cancels during the wait and does not expose authorization material', async () => {
    const controller = new AbortController()
    await expect(authorizeWithGitHub({ clientId: 'public-id', fetch: protocol([]), signal: controller.signal, wait: async (_ms, signal) => { controller.abort(); await new Promise<void>((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })) } })).rejects.toThrow('cancelled')
  })

  it('rejects HTTP and malformed response failures without exposing response bodies', async () => {
    const http: DeviceAuthHttp = async () => ({ ok: false, status: 401, json: async () => ({ secret: 'do not expose' }) })
    await expect(authorizeWithGitHub({ clientId: 'public-id', fetch: http })).rejects.toThrow('401')
    const malformed: DeviceAuthHttp = async () => response({ error_description: 'sensitive response' })
    await expect(authorizeWithGitHub({ clientId: 'public-id', fetch: malformed })).rejects.not.toThrow('sensitive response')
  })
})
