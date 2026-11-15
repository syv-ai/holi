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
  it('reads display annotations locally without requesting Gmail for known threads', async () => {
    const root = await temp()
    const cache = openGoogleCache(join(root, 'cache.db'))
    const markers = createMailMarkerStore(root, 'account-a')
    const ids = Array.from({ length: 100 }, (_, index) => `thread-${index}`)
    await Promise.all(ids.map((id) => markers.set(id, 'red-star')))
    const fetch = vi.fn(async () => Response.json({})) as typeof globalThis.fetch
    const data = createGoogleData({
      api: () => new GoogleApi({ accessToken: async () => 'token', fetch }),
      cache,
      markers,
    })

    expect(await data.mailMarkerAnnotations(ids)).toEqual(
      Object.fromEntries(ids.map((id) => [id, 'red-star'])),
    )
    expect(fetch).not.toHaveBeenCalled()
    cache.close()
  })

  it('rejects a local annotation read retired while the store read is pending', async () => {
    const root = await temp()
    const cache = openGoogleCache(join(root, 'cache.db'))
    let release!: (value: Record<string, 'red-star' | null>) => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => (started = resolve))
    const pending = new Promise<Record<string, 'red-star' | null>>((resolve) => (release = resolve))
    const markers = createMailMarkerStore(root, 'account-a')
    const data = createGoogleData({
      api: () => new GoogleApi({ accessToken: async () => 'token', fetch: vi.fn() as never }),
      cache,
      markers: {
        ...markers,
        read: async () => {
          started()
          return pending
        },
      },
    })
    const request = data.mailMarkerAnnotations(['thread-1'])
    await entered
    data.forget()
    release({ 'thread-1': 'red-star' })
    await expect(request).rejects.toThrow(/no longer connected/)
    cache.close()
  })
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

  it('persists preferences with annotations, reads legacy files, and serializes both writes', async () => {
    const root = await temp()
    const file = join(root, 'google-mail-markers-account-a.json')
    await writeFile(
      file,
      JSON.stringify({ version: 1, accountSub: 'account-a', threads: { legacy: 'red-star' } }),
    )
    const markers = createMailMarkerStore(root, 'account-a')
    expect(await markers.preferences()).toEqual({ enabledOrder: ['yellow-star'] })
    await Promise.all([
      markers.set('thread-2', 'blue-question'),
      markers.setPreferences({ enabledOrder: ['blue-question', 'red-star'] }),
    ])
    const recreated = createMailMarkerStore(root, 'account-a')
    expect(await recreated.read(['legacy', 'thread-2'])).toEqual({
      legacy: 'red-star',
      'thread-2': 'blue-question',
    })
    expect(await recreated.preferences()).toEqual({ enabledOrder: ['blue-question', 'red-star'] })
    await recreated.setPreferences({ enabledOrder: [] })
    expect(await markers.preferences()).toEqual({ enabledOrder: ['yellow-star'] })
  })

  it('rejects unknown and duplicate preference values without changing stored data', async () => {
    const root = await temp()
    const markers = createMailMarkerStore(root, 'account-a')
    await expect(
      markers.setPreferences({ enabledOrder: ['purple-star'] } as never),
    ).rejects.toThrow(/invalid/)
    await expect(
      markers.setPreferences({ enabledOrder: ['red-star', 'red-star'] }),
    ).rejects.toThrow(/duplicate/)
    await markers.set('thread-1', 'blue-question')
    const file = join(root, 'google-mail-markers-account-a.json')
    const saved = JSON.parse(await readFile(file, 'utf8')) as { threads: Record<string, string> }
    expect(saved.threads).toEqual({ 'thread-1': 'blue-question' })
  })

  it('keeps thread queue keys separate from the store queue', async () => {
    const markers = createMailMarkerStore(await temp(), 'account-a')
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => (release = resolve))
    const started = new Promise<void>((resolve) => (entered = resolve))
    const first = markers.runExclusive('store', async () => {
      entered()
      await blocked
    })
    await started
    const second = markers.set('store', 'red-star')
    release()
    await first
    let timer: ReturnType<typeof setTimeout>
    const bounded = Promise.race([
      second,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('hung')), 500)
      }),
    ])
    await expect(bounded).resolves.toBeUndefined()
    clearTimeout(timer!)
    expect(await markers.read(['store'])).toEqual({ store: 'red-star' })
  })

  it('roundtrips prototype-named Gmail thread ids as ordinary keys', async () => {
    const markers = createMailMarkerStore(await temp(), 'account-a')
    const ids = ['__proto__', 'constructor', 'toString']
    expect(await markers.read(ids)).toEqual(Object.fromEntries(ids.map((id) => [id, null])))
    for (const id of ids) await markers.set(id, 'blue-question')
    expect(await markers.read(ids)).toEqual(
      Object.fromEntries(ids.map((id) => [id, 'blue-question'])),
    )
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
        preferences: () => marked.preferences(),
        setPreferences: (preferences) => marked.setPreferences(preferences),
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

  it('revalidates a marker update after its asynchronous store read', async () => {
    const root = await temp()
    const markers = createMailMarkerStore(root, 'account-a')
    await markers.set('thread-1', 'red-star')
    let linked = true
    let entered!: () => void
    const admitted = new Promise<void>((resolve) => (entered = resolve))
    const validate = async () => {
      if (!linked) throw new Error('originating vault is no longer linked')
      entered()
    }
    const pending = markers.set('thread-1', 'blue-question', validate)
    await admitted
    linked = false
    await expect(pending).rejects.toThrow(/no longer linked/)
    expect(await markers.read(['thread-1'])).toEqual({ 'thread-1': 'red-star' })
  })

  it('does not return a disk-read marker after its originating vault is unlinked', async () => {
    const root = await temp()
    const markers = createMailMarkerStore(root, 'account-a')
    await markers.set('thread-1', 'red-star')
    let active = true
    const cache = openGoogleCache(join(root, 'cache.db'))
    let calls = 0
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const reading = new Promise<void>((resolve) => (started = resolve))
    const validate = async () => {
      calls += 1
      if (calls === 3) {
        started()
        await gate
      }
      if (!active) throw new Error('vault is no longer linked')
    }
    const fetch = vi.fn(async () => Response.json({})) as typeof globalThis.fetch
    const data = createGoogleData({
      api: () => new GoogleApi({ accessToken: async () => 'token', fetch }),
      cache,
      markers,
    })
    const pending = data.setMailMarker('thread-1', 'blue-question', validate)
    await reading
    active = false
    release()
    await expect(pending).rejects.toThrow(/no longer linked/)
    expect(fetch).not.toHaveBeenCalled()
    expect(await markers.read(['thread-1'])).toEqual({ 'thread-1': 'red-star' })
    cache.close()
  })

  it('revalidates the originating vault after refresh before either marker mutation POST', async () => {
    for (const rich of [false, true]) {
      const root = await temp()
      const cache = openGoogleCache(join(root, `cache-${rich}.db`))
      let originLinked = true
      let releaseToken!: (token: string) => void
      let started!: () => void
      const token = new Promise<string>((resolve) => (releaseToken = resolve))
      const refreshing = new Promise<void>((resolve) => (started = resolve))
      const fetch = vi.fn(async () => Response.json({})) as typeof globalThis.fetch
      const data = createGoogleData({
        api: () =>
          new GoogleApi({
            accessToken: () => {
              started()
              return token
            },
            fetch,
          }),
        cache,
        markers: createMailMarkerStore(root, 'account-a'),
      })
      const validate = async () => {
        if (!originLinked) throw new Error('originating vault is no longer linked')
      }
      const pending = rich
        ? data.setMailMarker('thread-1', 'red-star', validate)
        : data.setStarred('thread-1', true, validate)
      await refreshing
      originLinked = false
      releaseToken('fresh-token')
      await expect(pending).rejects.toThrow(/no longer linked/)
      expect(fetch).not.toHaveBeenCalled()
      cache.close()
    }
  })

  it('keeps a successful Gmail star in the shared cache but not the marker after unlink', async () => {
    for (const rich of [false, true]) {
      const root = await temp()
      const cache = openGoogleCache(join(root, `cache-${rich}.db`))
      const markers = createMailMarkerStore(root, 'account-a')
      await markers.set('thread-1', 'blue-question')
      const patchThread = vi.spyOn(cache, 'patchThread')
      let originLinked = true
      let release!: (response: Response) => void
      let started!: () => void
      const response = new Promise<Response>((resolve) => (release = resolve))
      const dispatched = new Promise<void>((resolve) => (started = resolve))
      const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          started()
          return response
        }
        return Response.json({ messages: [{ labelIds: ['STARRED'] }] })
      }) as typeof globalThis.fetch
      const data = createGoogleData({
        api: () => new GoogleApi({ accessToken: async () => 'token', fetch }),
        cache,
        markers,
      })
      data.ensureShape()
      const validate = async () => {
        if (!originLinked) throw new Error('originating vault is no longer linked')
      }
      const pending = rich
        ? data.setMailMarker('thread-1', 'red-star', validate)
        : data.setStarred('thread-1', true, validate)
      await dispatched
      originLinked = false
      release(Response.json({}))
      await expect(pending).rejects.toThrow(
        /Gmail star changed, but the personal marker was not saved/,
      )
      expect(await data.mailMarkers(['thread-1'])).toEqual({ 'thread-1': 'blue-question' })
      expect(await markers.read(['thread-1'])).toEqual({ 'thread-1': 'blue-question' })
      expect(patchThread).toHaveBeenCalledWith('thread-1', {
        added: ['STARRED'],
        removed: [],
      })
      cache.close()
    }
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
