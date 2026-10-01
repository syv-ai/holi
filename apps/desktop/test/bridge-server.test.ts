import { request } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerAgentRoutes } from '../src/main/agent/bridge-routes'
import { createBridgeServer, type BridgeServer } from '../src/main/bridge/server'
import type { Dispatch } from '../src/main/capabilities/dispatch'

/** POST to the running server; resolve with the status and (drained) body. */
function post(
  port: number,
  path: string,
  body = '',
  method = 'POST',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method }, (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const servers: BridgeServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
})

const VAULT = 'nthomsencph/privat'

async function rig(dispatch?: Dispatch) {
  // The job ids the callback was handed, in order: a turn signal is only
  // useful if it says WHICH session turned.
  const starts: string[] = []
  const ends: string[] = []
  const server = createBridgeServer({ dispatch, log: () => {} })
  registerAgentRoutes(server, {
    onJobTurn: (remote, job, active) => (active ? starts : ends).push(`${remote}:${job}`),
    log: () => {},
  })
  servers.push(server)
  await server.start()
  const token = server.tokenForVault(VAULT)
  return {
    server,
    port: () => server.port()!,
    token: () => token,
    starts: () => starts,
    ends: () => ends,
  }
}

describe('createBridgeServer', () => {
  it('binds an ephemeral port and mints a stable hex token per vault', async () => {
    const r = await rig()
    expect(r.port()).toBeGreaterThan(0)
    expect(r.token()).toMatch(/^[0-9a-f]{32}$/)
    // Stable for the vault: this one is written into the clone's `.git/hooks`,
    // so it has to keep working for as long as the app is running.
    expect(r.server.tokenForVault(VAULT)).toBe(r.token())
  })

  it('gives two vaults two tokens', async () => {
    const r = await rig()
    expect(r.server.tokenForVault('a/one')).not.toBe(r.server.tokenForVault('a/two'))
  })

  it('routes each token to ITS OWN vault, whatever else is open', async () => {
    // The hazard: `runPreCommit` used to resolve `host.active()`, so a commit in
    // vault A ran A's staged transforms against whichever vault was on screen —
    // rewriting files in the wrong repo.
    const asked: string[] = []
    const r = await rig()
    r.server.route('/hooks/pre-commit', {
      body: 'discard',
      handle: (remote) => {
        asked.push(remote)
        return { status: 204 }
      },
    })
    const mine = r.server.tokenForVault('me/personal')
    const theirs = r.server.tokenForVault('syv/work')

    await post(r.port(), `/hooks/pre-commit?t=${mine}`)
    await post(r.port(), `/hooks/pre-commit?t=${theirs}`)

    expect(asked).toEqual(['me/personal', 'syv/work'])
  })

  it('never resolves a vault for an unknown token', async () => {
    const asked: string[] = []
    const r = await rig()
    r.server.route('/hooks/pre-commit', {
      body: 'discard',
      handle: (remote) => {
        asked.push(remote)
        return { status: 204 }
      },
    })
    await post(r.port(), `/hooks/pre-commit?t=nope`).catch(() => undefined)
    expect(asked).toEqual([])
  })

  it('POST /turn/start with a job id names the vault and that session, and returns an empty 204', async () => {
    const r = await rig()
    const res = await post(r.port(), `/turn/start?t=${r.token()}&job=1234abcd`)
    expect(res.status).toBe(204)
    expect(res.body).toBe('')
    expect(r.starts()).toEqual([`${VAULT}:1234abcd`])
    expect(r.ends()).toEqual([])
  })

  it('POST /turn/end with a job id names that session', async () => {
    const r = await rig()
    await post(r.port(), `/turn/end?t=${r.token()}&job=1234abcd`)
    expect(r.ends()).toEqual([`${VAULT}:1234abcd`])
    expect(r.starts()).toEqual([])
  })

  it('tells two sessions in one vault apart', async () => {
    const r = await rig()
    await post(r.port(), `/turn/start?t=${r.token()}&job=aaaaaaaa`)
    await post(r.port(), `/turn/start?t=${r.token()}&job=bbbbbbbb`)
    await post(r.port(), `/turn/end?t=${r.token()}&job=bbbbbbbb`)
    expect(r.starts()).toEqual([`${VAULT}:aaaaaaaa`, `${VAULT}:bbbbbbbb`])
    expect(r.ends()).toEqual([`${VAULT}:bbbbbbbb`])
  })

  it('POST /statusline hands the status JSON over by vault and job, and answers an empty 204', async () => {
    const seen: unknown[] = []
    const server = createBridgeServer({ log: () => {} })
    registerAgentRoutes(server, {
      onJobTurn: () => {},
      onStatus: (remote, job, status) => seen.push([remote, job, status]),
      log: () => {},
    })
    servers.push(server)
    await server.start()
    const token = server.tokenForVault(VAULT)
    const status = { context_window: { used_percentage: 42 } }
    const send = (query: string, body: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(
          { host: '127.0.0.1', port: server.port()!, path: `/statusline?${query}`, method: 'POST' },
          (res) => {
            let text = ''
            res.on('data', (c) => (text += c))
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
          },
        )
        req.on('error', reject)
        req.end(body)
      })

    expect(await send(`t=${token}&job=1234abcd`, JSON.stringify(status))).toEqual({
      status: 204,
      body: '',
    })
    // No job, no row to put it on; malformed JSON, nothing to read.
    await send(`t=${token}&job=`, JSON.stringify(status))
    expect(await send(`t=${token}&job=1234abcd`, '{')).toEqual({ status: 204, body: '' })
    expect(seen).toEqual([[VAULT, '1234abcd', status]])
  })

  it('drops a turn signal that names no session', async () => {
    // With several sessions running there is no honest answer to "which one
    // turned", and guessing would pause and resume the vault under a session
    // that never ran. Still a 204: a body would enter Claude's context.
    const r = await rig()
    const res = await post(r.port(), `/turn/start?t=${r.token()}`)
    expect(res.status).toBe(204)
    expect(res.body).toBe('')
    expect(r.starts()).toEqual([])
    expect(r.ends()).toEqual([])
  })

  it('rejects a wrong or missing token with 403 and fires no callback', async () => {
    const r = await rig()
    const wrong = await post(r.port(), '/turn/start?t=nope')
    const missing = await post(r.port(), '/turn/start')
    expect(wrong.status).toBe(403)
    expect(missing.status).toBe(403)
    expect(r.starts()).toEqual([])
  })

  it('returns 404 for an unknown path even with a valid token', async () => {
    const r = await rig()
    const res = await post(r.port(), `/nope?t=${r.token()}`)
    expect(res.status).toBe(404)
    expect(r.starts()).toEqual([])
    expect(r.ends()).toEqual([])
  })

  it('stop() closes the listener so further requests cannot connect', async () => {
    const r = await rig()
    const port = r.port()
    await r.server.stop()
    await expect(post(port, `/turn/start?t=${r.token()}`)).rejects.toThrow()
  })
})

describe('routes and the capability door', () => {
  it('refuses a bad token before reading the body', async () => {
    // A megabyte of body with the wrong token must be turned away on the
    // headers, not accumulated first.
    const r = await rig()
    const res = await post(r.port(), '/turn/start?t=wrong', 'x'.repeat(1024 * 1024))
    expect(res.status).toBe(403)
  })

  it('405s a GET', async () => {
    const r = await rig()
    expect((await post(r.port(), `/turn/start?t=${r.token()}`, '', 'GET')).status).toBe(405)
  })

  it('gives a path one owner', async () => {
    const r = await rig()
    expect(() =>
      r.server.route('/turn/start', { body: 'discard', handle: () => ({ status: 204 }) }),
    ).toThrow(/taken/)
  })

  it('serves no capability without a dispatch', async () => {
    const r = await rig()
    expect((await post(r.port(), `/cap/store.list?t=${r.token()}`)).status).toBe(404)
  })

  it("runs a capability for the token's vault, with the form fields as params", async () => {
    const dispatch = vi.fn<Dispatch>(async () => ({ value: ['x'], text: 'x', writes: false }))
    const r = await rig(dispatch)
    const res = await post(
      r.port(),
      `/cap/store.list?t=${r.token()}`,
      'bundle=A.app&collection=items',
    )
    expect(res).toEqual({ status: 200, body: 'x' })
    expect(dispatch).toHaveBeenCalledWith({
      door: 'cli',
      remote: VAULT,
      bundle: null,
      name: 'store.list',
      params: { bundle: 'A.app', collection: 'items' },
    })
  })

  it('answers JSON when asked', async () => {
    const r = await rig(async () => ({ value: { a: 1 }, text: 'a', writes: false }))
    const res = await post(r.port(), `/cap/store.get?t=${r.token()}`, 'json=true')
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ a: 1 })
  })

  it('refuses with a 422 and the reason, so the command can exit non-zero', async () => {
    const r = await rig(async () => {
      throw new Error('no such method: nope')
    })
    const res = await post(r.port(), `/cap/nope?t=${r.token()}`)
    expect(res).toEqual({ status: 422, body: 'no such method: nope' })
  })
})
