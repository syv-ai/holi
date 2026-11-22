import { afterEach, expect, test, vi } from 'vitest'
import { accountApi } from '../main/account-api'
import type { GoogleSession } from '../main/session'

afterEach(() => vi.unstubAllGlobals())

test('a cached account client resolves the replacement session after reconnect', async () => {
  let session = { getAccessToken: vi.fn(async () => 'old-session-token') }
  const sessionForSub = vi.fn(() => session as unknown as GoogleSession)
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  }))
  vi.stubGlobal('fetch', fetch)
  const createClient = accountApi('account-1', sessionForSub)

  await createClient().get('https://www.googleapis.com/calendar/v3/users/me/calendarList')
  session = { getAccessToken: vi.fn(async () => 'replacement-session-token') }
  await createClient().get('https://www.googleapis.com/calendar/v3/users/me/calendarList')

  expect(sessionForSub).toHaveBeenCalledTimes(2)
  expect(
    fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization')),
  ).toEqual(['Bearer old-session-token', 'Bearer replacement-session-token'])
})
