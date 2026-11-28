import { afterEach, expect, test, vi } from 'vitest'
import { accountApi } from '../main/account-api'
import type { GoogleSession } from '../main/session'

afterEach(() => vi.unstubAllGlobals())

test('account clients use their connected session and refuse a replaced session', async () => {
  let session: GoogleSession | null = {
    getAccessToken: vi.fn(async () => 'old-session-token'),
  } as unknown as GoogleSession
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  }))
  vi.stubGlobal('fetch', fetch)
  const createClient = accountApi('account-1', () => session)
  const oldClient = createClient()

  await oldClient.get('https://www.googleapis.com/calendar/v3/users/me/calendarList')
  session = {
    getAccessToken: vi.fn(async () => 'replacement-session-token'),
  } as unknown as GoogleSession
  const replacementClient = createClient()
  await replacementClient.get('https://www.googleapis.com/calendar/v3/users/me/calendarList')

  await expect(
    oldClient.get('https://www.googleapis.com/calendar/v3/users/me/calendarList'),
  ).rejects.toThrow(/no longer connected/)
  expect(
    fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization')),
  ).toEqual(['Bearer old-session-token', 'Bearer replacement-session-token'])

  session = null
  expect(() => createClient()).toThrow(/no longer connected/)
  expect(fetch).toHaveBeenCalledTimes(2)
})
