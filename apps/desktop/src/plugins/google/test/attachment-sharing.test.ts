import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { ensureGuestViewers } from '../main/attachment-sharing'
import { GoogleApi } from '../main/api'

function setup(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  return new GoogleApi({
    accessToken: async () => 'token',
    fetch: async (input, init) => handler(new URL(String(input)), init ?? {}),
  })
}
const ok = (body: unknown) => Response.json(body)
const share = (accountSub: string, signal = AbortSignal.timeout(4_000)) => ({
  accountSub,
  signal,
  validate: async () => {},
  validateGuest: async () => {},
})

describe('ensureGuestViewers', () => {
  it('paginates, preserves stronger inherited access, and creates only private user readers', async () => {
    const notifications: string[] = []
    const existing = {
      id: 'p',
      type: 'user',
      emailAddress: 'Guest@example.com',
      role: 'writer',
      permissionDetails: [{ permissionType: 'file', inherited: true, role: 'writer' }],
    }
    const privatePermissions: unknown[] = [existing]
    const api = setup((url, init) => {
      if (init.method === 'GET' && url.searchParams.get('pageToken') !== 'next')
        return ok({
          permissions: [{ id: 'g', type: 'group', role: 'writer' }],
          nextPageToken: 'next',
        })
      if (init.method === 'GET') return ok({ permissions: privatePermissions })
      const body = JSON.parse(String(init.body))
      expect(body).toEqual({ type: 'user', role: 'reader', emailAddress: 'new@example.com' })
      expect(init.method).toBe('POST')
      if (url.searchParams.get('sendNotificationEmail') === 'true')
        notifications.push(body.emailAddress)
      privatePermissions.push({ id: 'new', ...body })
      return ok({ id: 'new' })
    })
    const { sharing } = await ensureGuestViewers(
      api,
      ['paginated'],
      ['guest@example.com', 'new@example.com'],
      share('a'),
    )
    expect(sharing.map((r) => r.status)).toEqual(['already-accessible', 'granted'])
    expect(notifications).toEqual(['new@example.com'])
  })

  it('serializes permission operations from different accounts on the same file without losing grants', async () => {
    const permissions = new Map<string, object>()
    const notifications: string[] = []
    const handler = async (_url: URL, init: RequestInit) => {
      if (init.method === 'GET') return ok({ permissions: [...permissions.values()] })
      const body = JSON.parse(String(init.body))
      const id = body.emailAddress as string
      notifications.push(id)
      // Model Drive's lost-update hazard: overlapping writes can each commit
      // from the same old set and replace each other's changes.
      const prior = [...permissions]
      await delay(5)
      permissions.clear()
      for (const [key, value] of prior) permissions.set(key, value)
      permissions.set(id, { ...body, id })
      return ok({ id })
    }
    const [first, second] = await Promise.all([
      ensureGuestViewers(setup(handler), ['same-file'], ['one@example.com'], share('a')),
      ensureGuestViewers(
        setup(handler),
        ['same-file'],
        ['one@example.com', 'two@example.com'],
        share('b'),
      ),
    ])
    expect(first.sharing[0]?.status).toMatch(/^(granted|already-accessible)$/)
    expect(
      second.sharing.every(({ status }) => status === 'granted' || status === 'already-accessible'),
    ).toBe(true)
    expect([...permissions.keys()].sort()).toEqual(['one@example.com', 'two@example.com'])
    expect(notifications.sort()).toEqual(['one@example.com', 'two@example.com'])
  })

  it('counts time waiting for a file queue against the operation deadline and does not grant later', async () => {
    let begin!: () => void
    const started = new Promise<void>((resolve) => {
      begin = resolve
    })
    let release!: () => void
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const permissions: object[] = []
    const notifications: string[] = []
    const api = setup(async (_url, init) => {
      if (init.method === 'GET') return ok({ permissions })
      const body = JSON.parse(String(init.body))
      notifications.push(body.emailAddress)
      if (body.emailAddress === 'holder@example.com') {
        begin()
        await hold
      }
      const id = body.emailAddress as string
      permissions.push({ ...body, id })
      return ok({ id })
    })
    const first = ensureGuestViewers(api, ['queued'], ['holder@example.com'], share('holder'))
    try {
      await started
      const expired = await ensureGuestViewers(
        api,
        ['queued', 'another-file'],
        ['queued@example.com'],
        share('queued', AbortSignal.timeout(20)),
      )
      expect(expired.sharing).toMatchObject([
        { fileId: 'queued', status: 'failed' },
        { fileId: 'another-file', status: 'failed' },
      ])
    } finally {
      release()
      await first
    }
    // A subsequent check drains the queue behind the cancelled waiter.
    const checked = await ensureGuestViewers(api, ['queued'], ['queued@example.com'], {
      ...share('queued'),
      validateGuest: undefined,
    })
    expect(checked.sharing[0]?.status).toBe('failed')
    expect(notifications).toEqual(['holder@example.com'])
  })
})
