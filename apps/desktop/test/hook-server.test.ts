import { request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createHookServer, type HookServer } from '../src/main/agent/hook-server'

/** POST to the running server; resolve with the status and (drained) body. */
function post(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'POST' },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

const servers: HookServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
})

async function rig() {
  let starts = 0
  let ends = 0
  const server = createHookServer({
    onTurnStart: () => (starts += 1),
    onTurnEnd: () => (ends += 1),
    log: () => {},
  })
  servers.push(server)
  await server.start()
  return { server, port: () => server.port()!, token: () => server.token(), starts: () => starts, ends: () => ends }
}

describe('createHookServer', () => {
  it('binds an ephemeral port and mints a stable hex token', async () => {
    const r = await rig()
    expect(r.port()).toBeGreaterThan(0)
    expect(r.token()).toMatch(/^[0-9a-f]{32}$/)
    expect(r.token()).toBe(r.token()) // stable
  })

  it('POST /turn/start with the token fires onTurnStart and returns an empty 204', async () => {
    const r = await rig()
    const res = await post(r.port(), `/turn/start?t=${r.token()}`)
    expect(res.status).toBe(204)
    expect(res.body).toBe('')
    expect(r.starts()).toBe(1)
    expect(r.ends()).toBe(0)
  })

  it('POST /turn/end with the token fires onTurnEnd', async () => {
    const r = await rig()
    await post(r.port(), `/turn/end?t=${r.token()}`)
    expect(r.ends()).toBe(1)
    expect(r.starts()).toBe(0)
  })

  it('rejects a wrong or missing token with 403 and fires no callback', async () => {
    const r = await rig()
    const wrong = await post(r.port(), '/turn/start?t=nope')
    const missing = await post(r.port(), '/turn/start')
    expect(wrong.status).toBe(403)
    expect(missing.status).toBe(403)
    expect(r.starts()).toBe(0)
  })

  it('returns 404 for an unknown path even with a valid token', async () => {
    const r = await rig()
    const res = await post(r.port(), `/nope?t=${r.token()}`)
    expect(res.status).toBe(404)
    expect(r.starts()).toBe(0)
    expect(r.ends()).toBe(0)
  })

  it('stop() closes the listener so further requests cannot connect', async () => {
    const r = await rig()
    const port = r.port()
    await r.server.stop()
    await expect(post(port, `/turn/start?t=${r.token()}`)).rejects.toThrow()
  })
})
