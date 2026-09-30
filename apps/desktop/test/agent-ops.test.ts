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
  const updateSkills = vi.fn(() =>
    Promise.resolve({ ok: true as const, report: {} as never, summary: 'Skills are up to date.' }),
  )
  const deps: AgentOpsDeps = { openApp, initApp, updateSkills, ...overrides }

  let starts = 0
  let ends = 0
  const server = createHookServer({
    onJobTurn: (_remote, _job, active) => (active ? (starts += 1) : (ends += 1)),
    log: () => {},
    // One vault in these; the server routes by the caller's token.
    opsFor: () => createAgentOps(deps),
  })
  servers.push(server)
  await server.start()
  return {
    port: () => server.port()!,
    token: () => server.tokenForVault('owner/repo'),
    openApp,
    initApp,
    updateSkills,
    starts: () => starts,
    ends: () => ends,
  }
}

describe('the turn signals keep their contract', () => {
  it("still answers with an EMPTY body — a body is injected into Claude's context", async () => {
    const r = await rig()
    // With a job id: a signal naming no session is dropped (hook-server.test.ts
    // covers that).
    for (const route of ['/turn/start', '/turn/end']) {
      const res = await post(r.port(), `${route}?t=${r.token()}&job=1234abcd`)
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
    const res = await post(r.port(), `/app/open?t=${r.token()}&path=Retro.app`)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
    expect(r.openApp).toHaveBeenCalledWith('Retro.app')
  })

  it('answers a refusal as a value, not a 500', async () => {
    const r = await rig({
      openApp: vi.fn(() => Promise.resolve({ ok: false as const, error: 'no app.yaml' })),
    })
    const res = await post(r.port(), `/app/open?t=${r.token()}&path=Half.app`)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'no app.yaml' })
  })

  it('refuses a missing path without calling the dep', async () => {
    const r = await rig()
    const res = await post(r.port(), `/app/open?t=${r.token()}`)
    expect(JSON.parse(res.body)).toMatchObject({ ok: false })
    expect(r.openApp).not.toHaveBeenCalled()
  })

  it('turns a thrown dep into a refusal rather than a 500', async () => {
    const r = await rig({ openApp: vi.fn(() => Promise.reject(new Error('vault is closed'))) })
    const res = await post(r.port(), `/app/open?t=${r.token()}&path=Retro.app`)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'vault is closed' })
  })
})

describe('auth and routing', () => {
  it('refuses a bad token before the dep is reached', async () => {
    const r = await rig()
    const res = await post(r.port(), '/app/open?t=wrong&path=Retro.app')
    expect(res.status).toBe(403)
    expect(r.openApp).not.toHaveBeenCalled()
  })

  it('refuses a bad token before reading the body', async () => {
    // A megabyte of body with the wrong token must be turned away on the
    // headers, not accumulated first.
    const r = await rig()
    const res = await post(r.port(), '/app/open?t=wrong&path=x', 'x'.repeat(1024 * 1024))
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
    const server = createHookServer({ onJobTurn: () => {}, log: () => {} })
    servers.push(server)
    await server.start()
    const res = await post(
      server.port()!,
      `/app/open?t=${server.tokenForVault('owner/repo')}&path=x`,
    )
    expect(res.status).toBe(404)
  })
})

describe('merge/record', () => {
  const enc = (fields: Record<string, string>) => new URLSearchParams(fields).toString()

  it('answers the merged record for edits of different fields', async () => {
    const r = await rig()
    const res = await post(
      r.port(),
      `/merge/record?t=${r.token()}`,
      enc({ base: '{"a":1,"b":1}', ours: '{"a":2,"b":1}', theirs: '{"a":1,"b":3}' }),
    )
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ a: 2, b: 3 })
  })

  it('answers 409 with the field when both sides changed it', async () => {
    const r = await rig()
    const res = await post(
      r.port(),
      `/merge/record?t=${r.token()}`,
      enc({ base: '{"a":1}', ours: '{"a":2}', theirs: '{"a":3}' }),
    )
    expect(res.status).toBe(409)
    expect(res.body).toBe('both changed: a')
  })

  it('takes three versions of a record at the store size cap', async () => {
    // URL-encoding can triple JSON, and the driver sends base, ours and theirs.
    const r = await rig()
    const big = JSON.stringify({ text: '"{}"'.repeat(60_000) })
    const res = await post(
      r.port(),
      `/merge/record?t=${r.token()}`,
      enc({ base: big, ours: big, theirs: big }),
    )
    expect(res.status).toBe(200)
  })

  it('reads an empty base as two additions of one id', async () => {
    const r = await rig()
    const res = await post(
      r.port(),
      `/merge/record?t=${r.token()}`,
      enc({ base: '', ours: '{"a":1}', theirs: '{"b":2}' }),
    )
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ a: 1, b: 2 })
  })
})

describe('cap/<method>', () => {
  it('runs a capability with the form fields as params, answering its text', async () => {
    const capability = vi.fn((_name: string, _params: Record<string, string>) =>
      Promise.resolve({ value: ['x'], text: 'x' }),
    )
    const r = await rig({ capability })
    const res = await post(
      r.port(),
      `/cap/store.list?t=${r.token()}`,
      'bundle=A.app&collection=items',
    )
    expect(res.status).toBe(200)
    expect(res.body).toBe('x')
    expect(capability).toHaveBeenCalledWith('store.list', { bundle: 'A.app', collection: 'items' })
  })

  it('answers JSON when asked', async () => {
    const r = await rig({
      capability: () => Promise.resolve({ value: { a: 1 }, text: 'a' }),
    })
    const res = await post(r.port(), `/cap/store.get?t=${r.token()}`, 'json=true')
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ a: 1 })
  })

  it('refuses with a 422 and the reason, so the command can exit non-zero', async () => {
    const r = await rig({ capability: () => Promise.reject(new Error('no such method: nope')) })
    const res = await post(r.port(), `/cap/nope?t=${r.token()}`)
    expect(res.status).toBe(422)
    expect(res.body).toBe('no such method: nope')
  })
})
