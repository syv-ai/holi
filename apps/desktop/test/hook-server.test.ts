import { request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createHookServer, type HookServer } from '../src/main/agent/hook-server'
import type { AgentOps } from '../src/main/agent/ops'

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

const VAULT = 'nthomsencph/privat'

async function rig(opsFor?: (remote: string) => AgentOps) {
  // The session ids the callbacks were handed, in order: a turn signal is only
  // useful if it says WHICH session turned.
  const starts: string[] = []
  const ends: string[] = []
  const server = createHookServer({
    onTurnStart: (sessionId) => starts.push(sessionId),
    onTurnEnd: (sessionId) => ends.push(sessionId),
    log: () => {},
    opsFor,
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

describe('createHookServer', () => {
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
    const r = await rig((remote) => {
      asked.push(remote)
      return async () => ({ status: 200, body: '{}' })
    })
    const mine = r.server.tokenForVault('me/personal')
    const theirs = r.server.tokenForVault('syv/work')
    // A session token resolves its vault the same way: an ops route is answered
    // for the repository, and carrying a session id changes nothing about that.
    const session = r.server.mintSessionToken('me/personal', 'sess-a')

    await post(r.port(), `/hooks/pre-commit?t=${mine}`)
    await post(r.port(), `/hooks/pre-commit?t=${theirs}`)
    await post(r.port(), `/hooks/pre-commit?t=${session}`)

    expect(asked).toEqual(['me/personal', 'syv/work', 'me/personal'])
  })

  it('mints a session token that can be revoked, unlike a vault one', async () => {
    // Two lifetimes, deliberately. The vault's token lives in a file on disk and
    // must outlast any session; an agent's dies with its session.
    const r = await rig()
    const session = r.server.mintSessionToken(VAULT, 's1')
    expect(session).not.toBe(r.token())

    expect((await post(r.port(), `/turn/start?t=${session}`)).status).toBe(204)
    r.server.revoke(session)
    expect((await post(r.port(), `/turn/start?t=${session}`)).status).toBe(403)
    // The vault's own token is untouched by that, and revoking it is refused —
    // it lives in a file on disk and must outlast any one session.
    r.server.revoke(r.token())
    expect((await post(r.port(), `/turn/start?t=${r.token()}`)).status).toBe(204)
  })

  it('never resolves a vault for an unknown token', async () => {
    const asked: string[] = []
    const r = await rig((remote) => {
      asked.push(remote)
      return async () => ({ status: 200, body: '{}' })
    })
    await post(r.port(), `/hooks/pre-commit?t=nope`).catch(() => undefined)
    expect(asked).toEqual([])
  })

  it('POST /turn/start on a session token names that session and returns an empty 204', async () => {
    const r = await rig()
    const session = r.server.mintSessionToken(VAULT, 'sess-a')
    const res = await post(r.port(), `/turn/start?t=${session}`)
    expect(res.status).toBe(204)
    expect(res.body).toBe('')
    expect(r.starts()).toEqual(['sess-a'])
    expect(r.ends()).toEqual([])
  })

  it('POST /turn/end on a session token names that session', async () => {
    const r = await rig()
    const session = r.server.mintSessionToken(VAULT, 'sess-a')
    await post(r.port(), `/turn/end?t=${session}`)
    expect(r.ends()).toEqual(['sess-a'])
    expect(r.starts()).toEqual([])
  })

  it('tells two sessions in one vault apart', async () => {
    const r = await rig()
    const a = r.server.mintSessionToken(VAULT, 'sess-a')
    const b = r.server.mintSessionToken(VAULT, 'sess-b')
    await post(r.port(), `/turn/start?t=${a}`)
    await post(r.port(), `/turn/start?t=${b}`)
    await post(r.port(), `/turn/end?t=${b}`)
    expect(r.starts()).toEqual(['sess-a', 'sess-b'])
    expect(r.ends()).toEqual(['sess-b'])
  })

  it('drops a turn signal arriving on the vault\'s standing token', async () => {
    // The standing token lives in `.git/hooks` and speaks for the vault, not for
    // any session. With several sessions running there is no honest answer to
    // "which one turned", and guessing would pause and resume the vault under a
    // session that never ran. Still a 204: a body would enter Claude's context.
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
