import { createServer, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { SseClient } from '../src/main/vault/sse-client'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitUntil(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout')
    await sleep(10)
  }
}

let server: Server | null = null
let client: SseClient | null = null
afterEach(async () => {
  client?.stop()
  await new Promise((r) => server?.close(r))
  server = null
})

function sseServer(onConn: (res: ServerResponse, connection: number) => void): Promise<string> {
  let connection = 0
  server = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer tok') {
      res.statusCode = 401
      return void res.end()
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    onConn(res, ++connection)
  })
  return new Promise((resolve) =>
    server!.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server!.address() as { port: number }).port}/events/v1`),
    ),
  )
}

describe('SseClient', () => {
  it('parses events, reconnects after a drop, and fires onReconnect', async () => {
    const url = await sseServer((res, connection) => {
      if (connection === 1) {
        res.write(':connected\n\n')
        res.write(`event: docs\ndata: {"type":"created","n":1}\n\n`)
        setTimeout(() => res.destroy(), 50) // server drops the stream
      } else {
        res.write(`event: tasks\ndata: {"type":"deleted","n":2}\n\n`)
      }
    })
    const events: Array<{ channel: string; data: unknown }> = []
    let reconnects = 0
    client = new SseClient({
      url,
      getToken: () => 'tok',
      onEvent: (channel, data) => events.push({ channel, data }),
      onReconnect: () => reconnects++,
      minBackoffMs: 20,
    })
    client.start()
    await waitUntil(() => events.length >= 2)
    expect(events[0]).toEqual({ channel: 'docs', data: { type: 'created', n: 1 } })
    expect(events[1]).toEqual({ channel: 'tasks', data: { type: 'deleted', n: 2 } })
    expect(reconnects).toBe(1)
  })

  it('stop() ends the loop — no further connections', async () => {
    let connections = 0
    const url = await sseServer((res) => {
      connections++
      setTimeout(() => res.destroy(), 20)
    })
    client = new SseClient({ url, getToken: () => 'tok', onEvent: () => {}, minBackoffMs: 20 })
    client.start()
    await waitUntil(() => connections >= 1)
    client.stop()
    const seen = connections
    await sleep(150)
    expect(connections).toBe(seen)
  })
})
