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
    // One vault in these; the server routes by the caller's token (D87).
    opsFor: () => createAgentOps(deps),
  })
  servers.push(server)
  await server.start()
  return {
    port: () => server.port()!,
    token: () => server.tokenForVault('owner/repo'),
    sessionToken: () => server.mintSessionToken('owner/repo', 'sess-a'),
    openApp,
    initApp,
    refreshSeed,
    starts: () => starts,
    ends: () => ends,
  }
}

describe('the turn signals keep their contract', () => {
  it("still answers with an EMPTY body — a body is injected into Claude's context", async () => {
    const r = await rig()
    // A session's own token: the vault's standing one names no session, so its
    // turn signals are dropped (hook-server.test.ts covers that).
    const token = r.sessionToken()
    for (const route of ['/turn/start', '/turn/end']) {
      const res = await post(r.port(), `${route}?t=${token}`)
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

describe('pdf/comments', () => {
  const thread = {
    id: 'h',
    page: 2,
    kind: 'note' as const,
    markedText: null,
    author: 'Ada Holm',
    created: null,
    modified: null,
    text: 'Why 60?',
    replies: [],
  }
  const reading = (result: Awaited<ReturnType<AgentOpsDeps['pdfComments']>>) =>
    vi.fn((_path: string) => Promise.resolve(result))

  it('answers the readable layout as plain text', async () => {
    const pdfComments = reading({ ok: true, path: 'docs/a b.pdf', threads: [thread] })
    const r = await rig({ pdfComments })
    const res = await post(r.port(), `/pdf/comments?t=${r.token()}`, 'path=docs%2Fa%20b.pdf')
    expect(res.status).toBe(200)
    expect(res.body).toBe('[From docs/a b.pdf, 1 comment]\n\nPage 2, note\n  Ada Holm\n  > Why 60?')
    expect(pdfComments).toHaveBeenCalledWith('docs/a b.pdf')
  })

  it('answers JSON when asked', async () => {
    const r = await rig({ pdfComments: reading({ ok: true, path: 'a.pdf', threads: [thread] }) })
    const res = await post(r.port(), `/pdf/comments?t=${r.token()}`, 'path=a.pdf&json=true')
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ path: 'a.pdf', threads: [{ id: 'h', page: 2 }] })
  })

  it('says so when there are no comments, as an answer and not a refusal', async () => {
    const r = await rig({ pdfComments: reading({ ok: true, path: 'a.pdf', threads: [] }) })
    const res = await post(r.port(), `/pdf/comments?t=${r.token()}`, 'path=a.pdf')
    expect(res.status).toBe(200)
    expect(res.body).toBe('No comments in a.pdf.')
  })

  it('refuses with a 422 and the reason, so the command can exit non-zero', async () => {
    const r = await rig({ pdfComments: reading({ ok: false, error: 'a.md is not a PDF' }) })
    const res = await post(r.port(), `/pdf/comments?t=${r.token()}`, 'path=a.md')
    expect(res.status).toBe(422)
    expect(res.body).toBe('a.md is not a PDF')
  })

  it('refuses a missing path without calling the dep', async () => {
    const pdfComments = reading({ ok: true, path: '', threads: [] })
    const r = await rig({ pdfComments })
    const res = await post(r.port(), `/pdf/comments?t=${r.token()}`)
    expect(res.status).toBe(422)
    expect(pdfComments).not.toHaveBeenCalled()
  })

  it('turns a thrown dep into a refusal', async () => {
    const r = await rig({ pdfComments: () => Promise.reject(new Error('pdfium broke')) })
    const res = await post(r.port(), `/pdf/comments?t=${r.token()}`, 'path=a.pdf')
    expect(res.status).toBe(422)
    expect(res.body).toBe('pdfium broke')
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
    const res = await post(server.port()!, `/app/open?t=${server.tokenForVault('owner/repo')}&id=x`)
    expect(res.status).toBe(404)
  })
})
