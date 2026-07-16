import { createServer, type Server } from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createBus, type Bus } from '../src/bus'
import { makeEventsHandler } from '../src/events'
import { membershipRouter } from '../src/routers/membership'
import { createTestDb, type TestDb } from '../src/test/db'
import { seedSession, seedUser, seedVault } from '../src/test/fixtures'
import type { Context } from '../src/trpc'

let t: TestDb
let bus: Bus
let server: Server
let base: string
let vaultId: string
let userId: string
let email: string
let token: string

const ctxFor = (uid: string): Context =>
  ({
    db: t.db,
    bus,
    getLiveDoc: () => null,
    user: { id: uid, email: 'x@syv.ai', name: null, avatarUrl: null },
    token: 'tok',
  }) as Context

beforeAll(async () => {
  t = await createTestDb()
  bus = createBus()
  email = 'streamer@syv.ai'
  const user = await seedUser(t.db, email)
  userId = user.id
  vaultId = (await seedVault(t.db, userId)).id
  token = await seedSession(t.db, userId)
  const handler = makeEventsHandler({ db: t.db, bus })
  server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/events') return void handler(req, res)
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  server.close()
  await t.destroy()
})

/**
 * Every connection this test file opens. Teardown is async — abort resolves before the
 * server's `close` handler has run — and a lingering connection is not inert: it still
 * holds a `user:<id>` listener, so it *also* subscribes to any vault the next test
 * invites this user into. That silently doubles the listener counts the assertions below
 * are made of, so the next test must start from a genuinely quiet bus.
 */
const opened: AbortController[] = []
afterEach(async () => {
  for (const c of opened) c.abort()
  opened.length = 0
  await waitUntil(() => bus.listenerCount(`user:${userId}`) === 0)
})

const docMeta = (vid: string, path: string) => ({
  id: '00000000-0000-0000-0000-000000000001',
  vaultId: vid,
  path,
  kind: 'note',
  createdAt: '',
  updatedAt: '',
})

type Frame = { channel: string; data: unknown }

/**
 * A persistent reader. It must drain the body in ONE loop for the life of the
 * connection: returning out of a `for await` over `res.body` calls the iterator's
 * `return()`, which **cancels the ReadableStream and closes the connection** — so a
 * read-n-then-stop helper silently makes every later assertion in the same test read a
 * dead socket.
 */
function streamOf(res: Response) {
  const queue: Frame[] = []
  const decoder = new TextDecoder()
  let buf = ''
  void (async () => {
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true })
        let sep: number
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, sep)
          buf = buf.slice(sep + 2)
          let channel = ''
          let data = ''
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) channel = line.slice(6).trim()
            if (line.startsWith('data:')) data = line.slice(5).trim()
          }
          if (channel && data) queue.push({ channel, data: JSON.parse(data) })
        }
      }
    } catch {
      // aborted — expected at teardown
    }
  })()
  return {
    async next(timeoutMs = 3000): Promise<Frame> {
      const start = Date.now()
      while (queue.length === 0) {
        if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for an SSE frame')
        await new Promise((r) => setTimeout(r, 5))
      }
      return queue.shift()!
    },
  }
}

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition never held')
    await new Promise((r) => setTimeout(r, 5))
  }
}

/**
 * Open the stream and wait until it is actually subscribed. `fetch` resolves on the
 * response *headers*, which the handler writes before it has awaited the membership
 * query — so emitting the instant `open()` returns races the subscribe and the frame is
 * dropped. Real clients do not care (a frame lost in that window is covered by the
 * reconnect reconcile), but a test must be deterministic.
 */
async function open(
  bearer = token,
  uid = userId,
): Promise<{ res: Response; controller: AbortController; events: ReturnType<typeof streamOf> }> {
  const controller = new AbortController()
  opened.push(controller)
  const res = await fetch(`${base}/events`, {
    headers: { authorization: `Bearer ${bearer}` },
    signal: controller.signal,
  })
  const events = streamOf(res)
  if (res.status === 200) await waitUntil(() => bus.listenerCount(`user:${uid}`) > 0)
  return { res, controller, events }
}

describe('GET /events — one stream per user (D50)', () => {
  it('every frame is an envelope naming the vault it came from', async () => {
    const { res, controller, events } = await open()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const doc = docMeta(vaultId, 'a.md')
    bus.emitDocs(vaultId, { type: 'created', doc })
    bus.emitTasks(vaultId, { type: 'deleted', taskId: 'task-1' })
    expect(await events.next()).toEqual({
      channel: 'docs',
      data: { vaultId, event: { type: 'created', doc } },
    })
    expect(await events.next()).toEqual({
      channel: 'tasks',
      data: { vaultId, event: { type: 'deleted', taskId: 'task-1' } },
    })
    controller.abort()
  })

  it('a vault you are not in never leaks in', async () => {
    const { controller, events } = await open()
    const stranger = await seedUser(t.db)
    const strangersVault = (await seedVault(t.db, stranger.id)).id
    // emitted first, and must never appear — the frame that follows it proves the
    // stream got that far without it
    bus.emitDocs(strangersVault, { type: 'created', doc: docMeta(strangersVault, 'secret.md') })
    bus.emitDocs(vaultId, { type: 'created', doc: docMeta(vaultId, 'mine.md') })
    expect(await events.next()).toEqual({
      channel: 'docs',
      data: { vaultId, event: { type: 'created', doc: docMeta(vaultId, 'mine.md') } },
    })
    controller.abort()
  })

  // Membership is now a subscription set, not an admission check: there is no vault in
  // the URL to be forbidden from, so 403 has nothing left to mean.
  it('rejects a missing token with 401', async () => {
    expect((await fetch(`${base}/events`)).status).toBe(401)
  })

  it('a user in no vaults still gets a stream, it is just quiet', async () => {
    const loner = await seedUser(t.db)
    const lonerToken = await seedSession(t.db, loner.id)
    const { res, controller } = await open(lonerToken, loner.id)
    expect(res.status).toBe(200)
    controller.abort()
  })

  // THE switcher fix (D51). A stream that resolved your vaults at connect would be wrong
  // from the moment you were invited — the new vault's frames would go to a key nobody
  // is listening on, which is exactly today's bug.
  it('re-keys live: a vault you are invited to starts arriving on the open connection', async () => {
    const { controller, events } = await open()
    const owner = await seedUser(t.db)
    const freshVault = (await seedVault(t.db, owner.id)).id
    // real invite path — fixtures insert memberships directly and would not emit
    await membershipRouter
      .createCaller(ctxFor(owner.id))
      .invite({ vaultId: freshVault, email, role: 'member' })
    expect(await events.next()).toEqual({
      channel: 'membership',
      data: { vaultId: freshVault, event: { type: 'joined' } },
    })
    // and now its docs reach a connection opened before the vault existed
    bus.emitDocs(freshVault, { type: 'created', doc: docMeta(freshVault, 'new.md') })
    expect(await events.next()).toEqual({
      channel: 'docs',
      data: { vaultId: freshVault, event: { type: 'created', doc: docMeta(freshVault, 'new.md') } },
    })
    controller.abort()
  })

  it('re-keys the other way: a vault you are removed from goes quiet mid-connection', async () => {
    const owner = await seedUser(t.db)
    const doomed = (await seedVault(t.db, owner.id)).id
    const ownerCaller = membershipRouter.createCaller(ctxFor(owner.id))
    await ownerCaller.invite({ vaultId: doomed, email, role: 'member' })
    const { controller, events } = await open()
    await ownerCaller.remove({ vaultId: doomed, userId })
    expect(await events.next()).toEqual({
      channel: 'membership',
      data: { vaultId: doomed, event: { type: 'left' } },
    })
    // that vault is a stranger's now — its frames must not arrive
    bus.emitDocs(doomed, { type: 'created', doc: docMeta(doomed, 'after.md') })
    bus.emitDocs(vaultId, { type: 'created', doc: docMeta(vaultId, 'still-mine.md') })
    expect(await events.next()).toEqual({
      channel: 'docs',
      data: { vaultId, event: { type: 'created', doc: docMeta(vaultId, 'still-mine.md') } },
    })
    controller.abort()
  })

  // setMaxListeners(0) means a leak raises no warning — this assertion is the only thing
  // between a reconnect storm and unbounded listeners.
  it('unsubscribes from every vault AND the user key when the client disconnects', async () => {
    const baseline = {
      docs: bus.listenerCount(`docs:${vaultId}`),
      tasks: bus.listenerCount(`tasks:${vaultId}`),
      reminders: bus.listenerCount(`reminders:${vaultId}`),
      presence: bus.listenerCount(`presence:${vaultId}`),
      user: bus.listenerCount(`user:${userId}`),
    }
    const { res, controller } = await open()
    expect(res.status).toBe(200)
    expect(bus.listenerCount(`docs:${vaultId}`)).toBe(baseline.docs + 1)
    expect(bus.listenerCount(`user:${userId}`)).toBe(baseline.user + 1)
    controller.abort()
    await waitUntil(() => bus.listenerCount(`user:${userId}`) === baseline.user)
    expect({
      docs: bus.listenerCount(`docs:${vaultId}`),
      tasks: bus.listenerCount(`tasks:${vaultId}`),
      reminders: bus.listenerCount(`reminders:${vaultId}`),
      presence: bus.listenerCount(`presence:${vaultId}`),
      user: bus.listenerCount(`user:${userId}`),
    }).toEqual(baseline)
  })

  // Teardown loops the *current* set, so "the vaults it opened with" is the wrong list —
  // this is the one a per-connection array captured at connect would leak.
  it('unsubscribes from a vault joined mid-connection, not just the ones it opened with', async () => {
    const owner = await seedUser(t.db)
    const late = (await seedVault(t.db, owner.id)).id
    const baseline = bus.listenerCount(`docs:${late}`)
    const { controller, events } = await open()
    await membershipRouter
      .createCaller(ctxFor(owner.id))
      .invite({ vaultId: late, email, role: 'member' })
    await events.next() // the membership frame — it has subscribed by now
    expect(bus.listenerCount(`docs:${late}`)).toBe(baseline + 1)
    controller.abort()
    await waitUntil(() => bus.listenerCount(`docs:${late}`) === baseline)
  })
})
