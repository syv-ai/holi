import { describe, expect, it } from 'vitest'
import { ensureGuestViewers } from '../main/attachment-sharing'
import { GoogleApi } from '../main/api'

function setup(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const api = new GoogleApi({
    accessToken: async () => 'token',
    fetch: (async (input, init) => handler(new URL(String(input)), init ?? {})) as typeof fetch,
  })
  return api
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

describe('ensureGuestViewers', () => {
  it('paginates, preserves stronger inherited access, and creates only private user readers', async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = []
    const api = setup((url, init) => {
      calls.push({ url, init })
      if (init.method === 'GET' && url.searchParams.get('pageToken') !== 'next')
        return ok({
          permissions: [{ id: 'g', type: 'group', role: 'writer' }],
          nextPageToken: 'next',
        })
      if (init.method === 'GET')
        return ok({
          permissions: [
            {
              id: 'p',
              type: 'user',
              emailAddress: 'Guest@example.com',
              role: 'writer',
              permissionDetails: [{ permissionType: 'file', inherited: true, role: 'writer' }],
            },
          ],
        })
      return ok({ id: 'new' })
    })
    const result = await ensureGuestViewers(
      api,
      ['f'],
      ['guest@example.com', 'new@example.com'],
      async () => {},
      async () => {},
    )
    expect(result.map((r) => r.status)).toEqual(['already-accessible', 'granted'])
    const writes = calls.filter(({ init }) => init.method !== 'GET')
    expect(writes.map(({ init }) => init.method)).toEqual(['POST'])
    const created = writes[0]!
    expect(JSON.parse(String(created.init.body))).toEqual({
      type: 'user',
      role: 'reader',
      emailAddress: 'new@example.com',
    })
    expect(created.url.searchParams.get('sendNotificationEmail')).toBe('true')
  })

  it('reports permission denial without granting and does not replay an ambiguous write', async () => {
    let posts = 0
    const api = setup((_url, init) => {
      if (init.method === 'GET') return ok({ permissions: [] })
      posts++
      if (posts === 1) return new Response('{}', { status: 403 })
      throw new Error('connection lost')
    })
    const result = await ensureGuestViewers(
      api,
      ['f'],
      ['denied@example.com', 'uncertain@example.com'],
      async () => {},
      async () => {},
    )
    expect(result.map((r) => r.status)).toEqual(['failed', 'unknown'])
    expect(posts).toBe(2)
  })

  it('revalidates guest membership immediately before a create', async () => {
    let writes = 0
    const api = setup((_url, init) => {
      if (init.method === 'POST') writes++
      return ok({ permissions: [] })
    })
    const result = await ensureGuestViewers(
      api,
      ['f'],
      ['guest@example.com'],
      async () => {},
      async () => {
        throw new Error('stale event')
      },
    )
    expect(result[0]?.status).toBe('failed')
    expect(writes).toBe(0)
  })
})
