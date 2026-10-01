import { request } from 'node:http'
import { taskClaim } from '@holi/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createBridgeServer, type BridgeServer } from '../src/main/bridge/server'
import { registerGitRoutes } from '../src/main/vault/git-routes'

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

const servers: BridgeServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
})

async function rig(rootFor: (remote: string) => Promise<string | null> = async () => null) {
  const server = createBridgeServer({ log: () => {} })
  registerGitRoutes(server, { rootFor, claims: async () => [taskClaim] })
  servers.push(server)
  await server.start()
  return {
    port: () => server.port()!,
    token: () => server.tokenForVault('owner/repo'),
  }
}

describe('hooks/pre-commit', () => {
  it('answers an empty run for a vault Holi does not have', async () => {
    const r = await rig()
    const res = await post(r.port(), `/hooks/pre-commit?t=${r.token()}`)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ changed: [], failed: [] })
  })

  it('turns a failure into an answer rather than a 500', async () => {
    const r = await rig(async () => {
      throw new Error('registry unreadable')
    })
    const res = await post(r.port(), `/hooks/pre-commit?t=${r.token()}`)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      changed: [],
      failed: [{ error: 'registry unreadable' }],
    })
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
