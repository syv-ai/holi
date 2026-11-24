import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureGuestViewers } from '../main/attachment-sharing'
import { GoogleApi } from '../main/api'
import { createPermissionReceipts } from '../main/permission-receipts'

function setup(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
  account = 'a',
) {
  return new GoogleApi({
    accessToken: async () => `token-${account}`,
    fetch: async (input, init) => handler(new URL(String(input)), init ?? {}),
  })
}
const ok = (body: unknown) => Response.json(body)
let userData: string
beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'holi-attachment-sharing-'))
})
afterEach(async () => {
  await rm(userData, { recursive: true, force: true })
})

const share = (signal = AbortSignal.timeout(4_000)) => ({
  receipts: createPermissionReceipts(userData),
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
      share(),
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
      ensureGuestViewers(setup(handler), ['same-file'], ['one@example.com'], share()),
      ensureGuestViewers(
        setup(handler, 'b'),
        ['same-file'],
        ['one@example.com', 'two@example.com'],
        share(),
      ),
    ])
    expect(first.sharing[0]?.status).toMatch(/^(granted|already-accessible)$/)
    expect(
      second.sharing.every(({ status }) => status === 'granted' || status === 'already-accessible'),
    ).toBe(true)
    expect([...permissions.keys()].sort()).toEqual(['one@example.com', 'two@example.com'])
    expect(notifications.sort()).toEqual(['one@example.com', 'two@example.com'])
  })

  it('blocks another account and guest after a lost POST until a read confirms the pending guest', async () => {
    const firstGuest = 'first@example.com'
    const secondGuest = 'second@example.com'
    const notified: string[] = []
    const permissions: object[] = []
    const deadline = new AbortController()
    const fileIds = ['late-write']
    let commit: (() => void) | undefined
    let durableAtDispatch: string | null = null
    let lostResponse = true
    const handler = async (_url: URL, req: RequestInit) => {
      if (req.method === 'GET') return ok({ permissions })
      const grant = JSON.parse(String(req.body))
      const id = grant.emailAddress as string
      notified.push(id)
      if (lostResponse) {
        // Drive can still commit after the client quits waiting. Keep it
        // pending while the other account reads the (still empty) ACL.
        lostResponse = false
        durableAtDispatch = await createPermissionReceipts(userData).read(fileIds[0]!)
        deadline.abort(new DOMException('Expired', 'TimeoutError'))
        return new Promise<Response>((resolve) => {
          commit = () => {
            permissions.push({ ...grant, id })
            resolve(ok({ id }))
          }
        })
      }
      permissions.push({ ...grant, id })
      return ok({ id })
    }
    await expect(
      ensureGuestViewers(setup(handler), fileIds, [firstGuest], share(deadline.signal)),
    ).resolves.toMatchObject({ sharing: [{ guest: firstGuest, status: 'unknown' }] })
    expect(durableAtDispatch).toBe(firstGuest)

    // Each call opens the same profile through a fresh store adapter (no
    // retained state from the first account).
    const other = setup(handler, 'b')
    const check = () =>
      ensureGuestViewers(other, fileIds, [firstGuest], {
        ...share(),
        validateGuest: undefined,
      })
    await expect(check()).resolves.toMatchObject({ sharing: [{ status: 'unknown' }] })
    await expect(ensureGuestViewers(other, fileIds, [secondGuest], share())).resolves.toMatchObject(
      { sharing: [{ guest: secondGuest, status: 'failed' }] },
    )
    expect(notified).toEqual([firstGuest])

    commit!()
    await expect(check()).resolves.toMatchObject({ sharing: [{ status: 'already-accessible' }] })
    await expect(ensureGuestViewers(other, fileIds, [secondGuest], share())).resolves.toMatchObject(
      { sharing: [{ guest: secondGuest, status: 'granted' }] },
    )
    expect(notified).toEqual([firstGuest, secondGuest])
  })

  it('does not send a grant if it cannot first save a receipt', async () => {
    const writes: unknown[] = []
    const api = setup((_url, req) => {
      if (req.method === 'GET') return ok({ permissions: [] })
      writes.push(req.body)
      return ok({ id: 'unexpected-grant' })
    })
    const receipts = createPermissionReceipts(join(userData, 'missing'))
    await expect(
      ensureGuestViewers(api, ['file'], ['one@example.com'], { ...share(), receipts }),
    ).resolves.toMatchObject({ sharing: [{ status: 'failed' }] })
    expect(writes).toEqual([])
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
    const first = ensureGuestViewers(api, ['queued'], ['holder@example.com'], share())
    try {
      await started
      const expired = await ensureGuestViewers(
        api,
        ['queued', 'another-file'],
        ['queued@example.com'],
        share(AbortSignal.timeout(20)),
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
      ...share(),
      validateGuest: undefined,
    })
    expect(checked.sharing[0]?.status).toBe('failed')
    expect(notifications).toEqual(['holder@example.com'])
  })
})
