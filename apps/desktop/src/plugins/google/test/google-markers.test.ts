import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GoogleApi } from '../main/api'
import { openGoogleCache } from '../main/cache'
import { createGoogleData } from '../main/data'
import { createMailMarkerStore } from '../main/markers'

let directory: string
const dirs: string[] = []
async function temp() {
  directory = await mkdtemp(join(tmpdir(), 'holi-mail-markers-'))
  dirs.push(directory)
  return directory
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('account-bound personal mail markers', () => {
  it('survives store recreation and isolates identical thread ids between accounts', async () => {
    const root = await temp()
    await createMailMarkerStore(root, 'account-a').set('thread-1', 'red-star')
    await createMailMarkerStore(root, 'account-b').set('thread-1', 'blue-question')

    expect(await createMailMarkerStore(root, 'account-a').read(['thread-1'])).toEqual({
      'thread-1': 'red-star',
    })
    expect(await createMailMarkerStore(root, 'account-b').read(['thread-1'])).toEqual({
      'thread-1': 'blue-question',
    })
  })

  it('serializes competing marker writes and validates thread ids and stored identity', async () => {
    const root = await temp()
    const markers = createMailMarkerStore(root, 'account-a')
    await Promise.all([
      markers.set('thread-1', 'red-star'),
      markers.set('thread-1', 'blue-question'),
      markers.set('thread-1', 'yellow-star'),
    ])
    expect(await createMailMarkerStore(root, 'account-a').read(['thread-1'])).toEqual({
      'thread-1': 'yellow-star',
    })
    await expect(markers.set('../outside', 'yellow-star')).rejects.toThrow(
      /invalid Gmail thread id/,
    )
    await expect(
      markers.read(Array.from({ length: 101 }, (_, index) => `thread-${index}`)),
    ).rejects.toThrow(/batch/)

    const file = join(root, 'google-mail-markers-account-a.json')
    await writeFile(file, JSON.stringify({ version: 1, accountSub: 'account-b', threads: {} }))
    await expect(createMailMarkerStore(root, 'account-a').read(['thread-1'])).rejects.toThrow(
      /invalid/,
    )
    expect(await readFile(file, 'utf8')).toContain('account-b')
    await writeFile(file, '{broken json')
    await expect(createMailMarkerStore(root, 'account-a').read(['thread-1'])).rejects.toThrow(
      /invalid/,
    )
    expect(await readFile(file, 'utf8')).toBe('{broken json')
  })

  it('orders writes across retired and replacement data handles for one account', async () => {
    const root = await temp()
    const markers = createMailMarkerStore(root, 'account-a')
    const cache1 = openGoogleCache(join(root, 'first.db'))
    const cache2 = openGoogleCache(join(root, 'second.db'))
    let release!: (response: Response) => void
    let started!: () => void
    const pending = new Promise<Response>((resolve) => (release = resolve))
    const requestStarted = new Promise<void>((resolve) => (started = resolve))
    const firstFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        started()
        return pending
      }
      return Response.json({ messages: [{ labelIds: [] }] })
    }) as typeof globalThis.fetch
    const secondFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Response.json({})
      return Response.json({ messages: [{ labelIds: ['STARRED'] }] })
    }) as typeof globalThis.fetch
    const first = createGoogleData({
      api: () => new GoogleApi({ accessToken: async () => 'token', fetch: firstFetch }),
      cache: cache1,
      markers,
    })
    const second = createGoogleData({
      api: () => new GoogleApi({ accessToken: async () => 'token', fetch: secondFetch }),
      cache: cache2,
      markers,
    })
    const stale = first.setMailMarker('thread-1', 'red-star')
    await requestStarted
    first.forget()
    const latest = second.setMailMarker('thread-1', 'blue-question')
    expect(secondFetch).not.toHaveBeenCalled()
    release(Response.json({}))
    await expect(stale).rejects.toThrow(/no longer connected/)
    await latest
    expect(secondFetch).toHaveBeenCalledOnce()
    expect(await markers.read(['thread-1'])).toEqual({ 'thread-1': 'blue-question' })
    cache2.close()
  })

  it('serializes purge before a replacement store writes the same account file', async () => {
    const root = await temp()
    const old = createMailMarkerStore(root, 'account-a')
    await old.set('thread-1', 'red-star')
    let release!: () => void
    let started!: () => void
    const waiting = new Promise<void>((resolve) => (release = resolve))
    const entered = new Promise<void>((resolve) => (started = resolve))
    const blocker = old.runExclusive('thread-1', async () => {
      started()
      await waiting
    })
    await entered
    const purge = old.purge()
    const replacement = createMailMarkerStore(root, 'account-a')
    const write = replacement.set('thread-1', 'blue-question')
    release()
    await expect(blocker).rejects.toThrow(/no longer connected/)
    await Promise.all([purge, write])
    expect(await replacement.read(['thread-1'])).toEqual({ 'thread-1': 'blue-question' })
  })

  it('purges only a removed account and preserves data for another account', async () => {
    const root = await temp()
    const removed = createMailMarkerStore(root, 'account-a')
    await removed.set('thread-1', 'red-star')
    await createMailMarkerStore(root, 'account-b').set('thread-1', 'yellow-star')

    await removed.purge()

    await expect(removed.read(['thread-1'])).rejects.toThrow(/no longer connected/)
    expect(await createMailMarkerStore(root, 'account-a').read(['thread-1'])).toEqual({
      'thread-1': null,
    })
    expect(await createMailMarkerStore(root, 'account-b').read(['thread-1'])).toEqual({
      'thread-1': 'yellow-star',
    })
  })

  it('syncs Gmail STARRED, preserves a rich marker for boolean star, and reflects a partial failure', async () => {
    const root = await temp()
    const cache = openGoogleCache(join(root, 'cache.db'))
    const marked = createMailMarkerStore(root, 'account-a')
    let starred = false
    let failDisk = false
    let failProvider = false
    const writes: string[] = []
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname
      if (init?.method === 'POST') {
        writes.push(url)
        if (failProvider) return Response.json({}, { status: 403 })
        starred =
          (
            JSON.parse(String(init.body)) as { addLabelIds?: string[]; removeLabelIds?: string[] }
          ).addLabelIds?.includes('STARRED') === true
        return Response.json({})
      }
      if (path.endsWith('/threads/thread-1'))
        return Response.json({ messages: [{ labelIds: starred ? ['STARRED'] : [] }] })
      return Response.json({})
    }) as typeof globalThis.fetch
    const data = createGoogleData({
      api: () => new GoogleApi({ accessToken: async () => 'token', fetch }),
      cache,
      markers: {
        read: (ids) => marked.read(ids),
        set: async (id, marker) => {
          if (failDisk) throw new Error('disk unavailable')
          await marked.set(id, marker)
        },
        runExclusive: (id, work) => marked.runExclusive(id, work),
        purge: () => marked.purge(),
      },
    })
    data.ensureShape()

    await data.setMailMarker('thread-1', 'red-star')
    await data.setStarred('thread-1', true)
    expect(await data.mailMarkers(['thread-1'])).toEqual({ 'thread-1': 'red-star' })

    failProvider = true
    await expect(data.setMailMarker('thread-1', 'blue-question')).rejects.toThrow()
    expect(await marked.read(['thread-1'])).toEqual({ 'thread-1': 'red-star' })
    failProvider = false
    failDisk = true
    await expect(data.setMailMarker('thread-1', 'blue-question')).rejects.toThrow(
      /Gmail star changed/,
    )
    expect(starred).toBe(true)
    expect(await marked.read(['thread-1'])).toEqual({ 'thread-1': 'red-star' })
    expect(writes).toHaveLength(4)
    cache.close()
  })

  it('resolves an external Gmail star as the ordinary marker without erasing stored rich data', async () => {
    const root = await temp()
    const cache = openGoogleCache(join(root, 'cache.db'))
    const markers = createMailMarkerStore(root, 'account-a')
    await markers.set('thread-1', 'red-star')
    let labels = ['STARRED']
    const fetch = vi.fn(async (url: string) => {
      if (new URL(url).pathname.includes('/threads/'))
        return Response.json({ messages: [{ labelIds: labels }] })
      return Response.json({})
    }) as typeof globalThis.fetch
    const data = createGoogleData({
      api: () => new GoogleApi({ accessToken: async () => 'token', fetch }),
      cache,
      markers,
    })
    data.ensureShape()
    expect(await data.mailMarkers(['thread-1'])).toEqual({ 'thread-1': 'red-star' })
    expect(await data.mailMarkers(['thread-2'])).toEqual({ 'thread-2': 'yellow-star' })

    labels = []
    expect(await data.mailMarkers(['thread-1'])).toEqual({ 'thread-1': null })
    expect(await markers.read(['thread-1'])).toEqual({ 'thread-1': 'red-star' })
    cache.close()
  })
})
