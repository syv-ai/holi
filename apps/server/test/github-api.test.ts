import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createGithubApi } from '../src/git/github-api'

let server: Server
let baseUrl: string
const seen: Array<{ method: string; url: string; auth?: string; body?: unknown }> = []

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => (raw += c.toString()))
    req.on('end', () => {
      seen.push({
        method: req.method!,
        url: req.url!,
        auth: req.headers.authorization,
        body: raw ? JSON.parse(raw) : undefined,
      })
      res.setHeader('content-type', 'application/json')
      if (req.url === '/login/oauth/access_token') return res.end(JSON.stringify({ access_token: 'gho_x' }))
      if (req.url === '/user') return res.end(JSON.stringify({ id: 7, login: 'nicolai' }))
      if (req.url === '/repos/o/r')
        return res.end(JSON.stringify({ default_branch: 'main', permissions: { admin: true } }))
      if (req.url === '/repos/o/r/keys') return res.end(JSON.stringify({ id: 11 }))
      if (req.url === '/repos/o/r/hooks') return res.end(JSON.stringify({ id: 22 }))
      res.statusCode = 404
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as { port: number }
  baseUrl = `http://127.0.0.1:${addr.port}`
})
afterAll(() => server.close())

describe('createGithubApi', () => {
  it('drives the endpoints with the right auth + payloads', async () => {
    const api = createGithubApi({
      clientId: 'cid',
      clientSecret: 'csec',
      apiBaseUrl: baseUrl,
      oauthBaseUrl: baseUrl,
    })
    expect(await api.exchangeCode('the-code')).toEqual({ accessToken: 'gho_x' })
    expect(await api.getUser('gho_x')).toEqual({ id: 7, login: 'nicolai' })
    expect(await api.getRepo('gho_x', 'o', 'r')).toEqual({ defaultBranch: 'main', admin: true })
    expect(await api.createDeployKey('gho_x', 'o', 'r', 'holi', 'ssh-ed25519 AAA')).toEqual({ id: 11 })
    expect(await api.createWebhook('gho_x', 'o', 'r', 'https://x/webhooks/github', 's3c')).toEqual({ id: 22 })

    const keyReq = seen.find((r) => r.url === '/repos/o/r/keys')!
    expect(keyReq.auth).toBe('Bearer gho_x')
    expect(keyReq.body).toMatchObject({ key: 'ssh-ed25519 AAA', read_only: false })
    const hookReq = seen.find((r) => r.url === '/repos/o/r/hooks')!
    expect(hookReq.body).toMatchObject({
      events: ['push'],
      config: { url: 'https://x/webhooks/github', secret: 's3c', content_type: 'json' },
    })
  })

  it('throws a readable error on non-2xx', async () => {
    const api = createGithubApi({ clientId: 'c', clientSecret: 's', apiBaseUrl: baseUrl, oauthBaseUrl: baseUrl })
    await expect(api.getRepo('t', 'nope', 'nope')).rejects.toThrow(/404/)
  })
})
