import { request } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHookServer, type HookServer } from '../src/main/agent/hook-server'
import { createAgentOps, type AgentOpsDeps } from '../src/main/agent/ops'

interface Reply {
  status: number
  body: string
}

function post(port: number, path: string, body = ''): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST' }, (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const servers: HookServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
})

async function rig(overrides: Partial<AgentOpsDeps> = {}) {
  const openApp = vi.fn((_id: string) => Promise.resolve({ ok: true as const }))
  const initApp = vi.fn((_id: string) => Promise.resolve({ ok: true as const, created: [] }))
  const refreshSeed = vi.fn(() => Promise.resolve({ refreshed: [], skipped: [] }))
  const deps: AgentOpsDeps = { openApp, initApp, refreshSeed, ...overrides }

  let starts = 0
  let ends = 0
  const server = createHookServer({
    onTurnStart: () => (starts += 1),
    onTurnEnd: () => (ends += 1),
    log: () => {},
    ops: createAgentOps(deps),
  })
  servers.push(server)
  await server.start()
  return {
    port: () => server.port()!,
    token: () => server.token(),
    openApp,
    initApp,
    refreshSeed,
    starts: () => starts,
    ends: () => ends,
  }
}

describe('the turn signals keep their contract', () => {
  it('still answers with an EMPTY body — a body is injected into Claude\'s context', async () => {
    const r = await rig()
    for (const route of ['/turn/start', '/turn/end']) {
      const res = await post(r.port(), `${route}?t=${r.token()}`)
      expect(res.status).toBe(204)
      expect(res.body).toBe('')
    }
    expect(r.starts()).toBe(1)
    expect(r.ends()).toBe(1)
  })
})

describe('app/open', () => {
  it('opens the app and answers ok', async () => {
    const r = await rig()
    const res = await post(r.port(), `/app/open?t=${r.token()}&id=retro-board`)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
    expect(r.openApp).toHaveBeenCalledWith('retro-board')
  })

  it('answers a refusal as a value, not a 500', async () => {
    const r = await rig({
      openApp: vi.fn(() => Promise.resolve({ ok: false as const, error: 'no app.yaml' })),
    })
    const res = await post(r.port(), `/app/open?t=${r.token()}&id=half-written`)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'no app.yaml' })
  })

  it('refuses a missing id without calling the dep', async () => {
    const r = await rig()
    const res = await post(r.port(), `/app/open?t=${r.token()}`)
    expect(JSON.parse(res.body)).toMatchObject({ ok: false })
    expect(r.openApp).not.toHaveBeenCalled()
  })

  it('turns a thrown dep into a refusal rather than a 500', async () => {
    const r = await rig({ openApp: vi.fn(() => Promise.reject(new Error('vault is closed'))) })
    const res = await post(r.port(), `/app/open?t=${r.token()}&id=retro-board`)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'vault is closed' })
  })
})

describe('auth and routing', () => {
  it('refuses a bad token before the dep is reached', async () => {
    const r = await rig()
    const res = await post(r.port(), '/app/open?t=wrong&id=retro-board')
    expect(res.status).toBe(403)
    expect(r.openApp).not.toHaveBeenCalled()
  })

  it('refuses a bad token before reading the body', async () => {
    // A megabyte of body with the wrong token must be turned away on the
    // headers, not accumulated first.
    const r = await rig()
    const res = await post(r.port(), '/app/open?t=wrong&id=x', 'x'.repeat(1024 * 1024))
    expect(res.status).toBe(403)
  })

  it('404s an unknown route', async () => {
    const r = await rig()
    expect((await post(r.port(), `/app/nope?t=${r.token()}`)).status).toBe(404)
    expect((await post(r.port(), `/nope?t=${r.token()}`)).status).toBe(404)
  })

  it('405s a GET', async () => {
    const r = await rig()
    const res = await new Promise<Reply>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: r.port(), path: `/app/open?t=${r.token()}`, method: 'GET' },
        (res) => {
          let text = ''
          res.on('data', (c) => (text += c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
        },
      )
      req.on('error', reject)
      req.end()
    })
    expect(res.status).toBe(405)
  })

  it('serves ops with no ops dep at all as a 404, not a crash', async () => {
    const server = createHookServer({ onTurnStart: () => {}, onTurnEnd: () => {}, log: () => {} })
    servers.push(server)
    await server.start()
    const res = await post(server.port()!, `/app/open?t=${server.token()}&id=x`)
    expect(res.status).toBe(404)
  })
})
