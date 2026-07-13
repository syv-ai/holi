import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBus, type Bus } from '../src/bus'
import { makeEventsHandler } from '../src/events'
import { createTestDb, type TestDb } from '../src/test/db'
import { seedSession, seedUser, seedVault } from '../src/test/fixtures'

let t: TestDb
let bus: Bus
let server: Server
let base: string
let vaultId: string
let token: string

beforeAll(async () => {
  t = await createTestDb()
  bus = createBus()
  const user = await seedUser(t.db)
  vaultId = (await seedVault(t.db, user.id)).id
  token = await seedSession(t.db, user.id)
  const handler = makeEventsHandler({ db: t.db, bus })
  server = createServer((req, res) => {
    const m = /^\/events\/([0-9a-f-]{36})$/.exec(req.url ?? '')
    if (req.method === 'GET' && m) return void handler(req, res, m[1]!)
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

/** Read SSE blocks off a fetch response until `count` events arrived. */
async function readEvents(res: Response, count: number): Promise<Array<{ channel: string; data: unknown }>> {
  const out: Array<{ channel: string; data: unknown }> = []
  const decoder = new TextDecoder()
  let buf = ''
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
      if (channel && data) out.push({ channel, data: JSON.parse(data) })
      if (out.length >= count) return out
    }
  }
  return out
}

describe('GET /events/<vaultId>', () => {
  it('streams docs + tasks events for the vault, not others', async () => {
    const res = await fetch(`${base}/events/${vaultId}`, { headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const doc = { id: '00000000-0000-0000-0000-000000000001', vaultId, path: 'a.md', kind: 'note', createdAt: '', updatedAt: '' }
    // an event for a DIFFERENT vault must not leak into this stream
    bus.emitDocs('99999999-9999-4999-8999-999999999999', { type: 'created', doc: { ...doc, vaultId: 'other' } })
    bus.emitDocs(vaultId, { type: 'created', doc })
    bus.emitTasks(vaultId, { type: 'deleted', taskId: 'task-1' })
    const events = await readEvents(res, 2)
    expect(events[0]).toEqual({ channel: 'docs', data: { type: 'created', doc } })
    expect(events[1]).toEqual({ channel: 'tasks', data: { type: 'deleted', taskId: 'task-1' } })
  })

  it('rejects a missing token with 401 and a non-member with 403', async () => {
    expect((await fetch(`${base}/events/${vaultId}`)).status).toBe(401)
    const outsider = await seedUser(t.db)
    const outsiderToken = await seedSession(t.db, outsider.id)
    expect(
      (await fetch(`${base}/events/${vaultId}`, { headers: { authorization: `Bearer ${outsiderToken}` } })).status,
    ).toBe(403)
  })

  it('unsubscribes from the bus when the client disconnects', async () => {
    const before = bus.listenerCount(`docs:${vaultId}`)
    const controller = new AbortController()
    const res = await fetch(`${base}/events/${vaultId}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    expect(res.status).toBe(200)
    expect(bus.listenerCount(`docs:${vaultId}`)).toBe(before + 1)
    controller.abort()
    await new Promise((r) => setTimeout(r, 100))
    expect(bus.listenerCount(`docs:${vaultId}`)).toBe(before)
  })
})
