import { describe, expect, it, vi } from 'vitest'
import { createCancellation, type DeviceAuthHttp } from '../app/device-auth'
import { createGitHubCredentials, KeychainError } from '../app/github-credentials'

const device = {
  device_code: 'private-code',
  user_code: 'ABCD',
  verification_uri: 'https://github.com/login/device',
  expires_in: 60,
  interval: 1,
}
const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
const http: DeviceAuthHttp = async (_url, init) =>
  response(init.body.includes('device_code=') ? { access_token: 'new-token' } : device)

function setup(initial: string | null = 'old-token') {
  let token = initial
  const openStore = () => ({
    read: () => token,
    write: (value: string) => (token = value),
    remove: () => (token = null),
  })
  return { credentials: createGitHubCredentials(openStore()), openStore }
}

describe('GitHub credentials', () => {
  it('reads persisted values and replaces them only after completing device authorization', async () => {
    const { credentials } = setup()
    expect(credentials.readToken()).toBe('old-token')
    const auth = await credentials.authorize({
      clientId: 'public-id',
      fetch: http,
      wait: async () => {},
    })
    expect(credentials.readToken()).toBe('old-token')
    expect(auth.userCode).toBe('ABCD')
    await auth.wait()
    expect(credentials.readToken()).toBe('new-token')
    await expect(auth.wait()).rejects.toThrow()
  })

  it('allows missing credentials and repeated sign-out', () => {
    const { credentials } = setup(null)
    expect(credentials.readToken()).toBeNull()
    expect(() => credentials.signOut()).not.toThrow()
    expect(() => credentials.signOut()).not.toThrow()
  })

  it('preserves the prior token and sanitizes storage failures', async () => {
    const value: string | null = 'old-token'
    const credentials = createGitHubCredentials({
      read: () => value,
      write: () => {
        throw new Error('iOS Keychain write failed (OSStatus -34018)')
      },
      remove: () => {
        throw new Error('secret storage detail')
      },
    })
    const auth = await credentials.authorize({
      clientId: 'public-id',
      fetch: http,
      wait: async () => {},
    })
    const waiting = auth.wait()
    await expect(waiting).rejects.not.toThrow('OSStatus')
    expect(KeychainError.diagnostic(await waiting.catch((error: unknown) => error))).toBeUndefined()
    expect(credentials.readToken()).toBe('old-token')
    expect(() => credentials.signOut()).toThrow()
    expect(() => credentials.signOut()).not.toThrow('secret storage detail')
  })

  it('retains only sanitized Keychain details after write and sign-out failures', async () => {
    const fail = (operation: 'write' | 'remove', status: number) => () => {
      const error = new KeychainError(operation, status)
      error.message = 'private adapter detail'
      error.stack = 'private stack'
      error.cause = new Error('private cause')
      throw error
    }
    const credentials = createGitHubCredentials({
      read: () => 'old-token',
      write: fail('write', -34018),
      remove: fail('remove', -25308),
    })
    const auth = await credentials.authorize({
      clientId: 'public',
      fetch: http,
      wait: async () => {},
    })
    expect.assertions(9)
    const checkFailure = (operation: 'write' | 'remove', status: number) => (error: unknown) => {
      expect(KeychainError.diagnostic(error)).toEqual({ kind: 'keychain', operation, status })
      expect(String(error)).not.toContain('private')
      expect((error as Error).stack).not.toContain('private stack')
      expect(error).not.toHaveProperty('cause')
    }
    await auth.wait().catch(checkFailure('write', -34018))
    try {
      credentials.signOut()
    } catch (error) {
      checkFailure('remove', -25308)(error)
    }
    expect(credentials.readToken()).toBe('old-token')
  })

  it('invalidates an authorization superseded before its device code arrives', async () => {
    let resolve!: (value: ReturnType<typeof response>) => void
    const firstHttp: DeviceAuthHttp = () => new Promise((done) => (resolve = done))
    const { credentials } = setup()
    const first = credentials.authorize({ clientId: 'public-id', fetch: firstHttp })
    const second = credentials.authorize({
      clientId: 'public-id',
      fetch: http,
      wait: async () => {},
    })
    resolve(response(device))
    await expect(first).rejects.toThrow()
    await (await second).wait()
    expect(credentials.readToken()).toBe('new-token')
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it.each(['replacement', 'sign-out'])(
  'can revoke an authorization started during %s',
  async (action) => {
    const { credentials, openStore } = setup()
    const reopened = createGitHubCredentials(openStore())
    const polling = deferred<void>()
    const tokenReply = deferred<ReturnType<typeof response>>()
    let latest!: ReturnType<typeof credentials.authorize>
    let abortObserved = false
    const latestFetch: DeviceAuthHttp = async (url, { signal }) => {
      if (url.endsWith('/device/code')) return response(device)
      signal.addEventListener('abort', () => {
        abortObserved = true
      })
      polling.resolve()
      return tokenReply.promise
    }
    const firstFetch: DeviceAuthHttp = (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          latest = reopened.authorize({
            clientId: 'public',
            fetch: latestFetch,
            wait: async () => {},
          })
          reject(new Error('Transport aborted'))
        })
      })
    const first = credentials.authorize({ clientId: 'public', fetch: firstFetch })
    const outerFetch = vi.fn(http)
    if (action === 'replacement') {
      const outer = credentials.authorize({ clientId: 'public', fetch: outerFetch })
      await Promise.all([expect(first).rejects.toThrow(), expect(outer).rejects.toThrow()])
    } else {
      credentials.signOut()
      await expect(first).rejects.toThrow()
    }
    const waiting = (await latest).wait()
    await Promise.race([polling.promise, waiting])
    try {
      reopened.signOut()
    } finally {
      tokenReply.resolve(response({ access_token: 'late-token' }))
    }
    await expect(waiting).rejects.toThrow()
    expect(abortObserved).toBe(true)
    expect(outerFetch).not.toHaveBeenCalled()
    expect(credentials.readToken()).toBeNull()
  },
)

it.each(['cancel', 'sign-out', 'failed-sign-out', 'supersede', 'repeat-wait'])(
  'handles %s while token JSON is delayed',
  async (action) => {
    const { credentials, openStore } = setup()
    const cancellation = createCancellation()
    const reached = deferred<void>()
    const json = deferred<unknown>()
    let abortObserved = false
    const fetch: DeviceAuthHttp = async (url, { signal }) => {
      if (url.endsWith('/device/code')) return response(device)
      if (action === 'sign-out' || action === 'supersede') {
        signal.addEventListener('abort', () => {
          throw new Error('HTTP adapter abort failed')
        })
        signal.addEventListener('abort', () => {
          abortObserved = true
        })
      }
      return {
        ok: true,
        status: 200,
        json: () => {
          reached.resolve()
          return json.promise
        },
      }
    }
    const auth = await credentials.authorize({
      clientId: 'public',
      fetch,
      signal: cancellation.signal,
      wait: async () => {},
    })
    const waiting = auth.wait()
    await reached.promise
    // Like fresh native adapters, these objects share storage but not JS identity.
    const store = openStore()
    if (action === 'failed-sign-out') {
      store.remove = () => {
        throw new Error('private deletion detail')
      }
    }
    const reopened = createGitHubCredentials(store)
    let next: Awaited<ReturnType<typeof credentials.authorize>> | undefined
    try {
      if (action === 'cancel') cancellation.abort()
      else if (action === 'sign-out') {
        reopened.signOut()
        expect(reopened.readToken()).toBeNull()
      } else if (action === 'failed-sign-out') expect(() => reopened.signOut()).toThrow()
      else if (action === 'supersede')
        next = await reopened.authorize({ clientId: 'public', fetch: http, wait: async () => {} })
      else await expect(auth.wait()).rejects.toThrow()
    } finally {
      json.resolve({ access_token: 'delayed-token' })
      await waiting.catch(() => {})
    }
    if (action === 'repeat-wait') {
      await waiting
      expect(credentials.readToken()).toBe('delayed-token')
      expect(reopened.readToken()).toBe('delayed-token')
    } else {
      await expect(waiting).rejects.toThrow()
      expect(reopened.readToken()).toBe(action === 'sign-out' ? null : 'old-token')
      if (action === 'sign-out' || action === 'supersede') expect(abortObserved).toBe(true)
      if (action === 'sign-out')
        next = await reopened.authorize({ clientId: 'public', fetch: http, wait: async () => {} })
      if (next) {
        await next.wait()
        expect(credentials.readToken()).toBe('new-token')
      }
    }
  },
)
