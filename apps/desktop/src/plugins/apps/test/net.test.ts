/** `holi.fetch`'s main side: only listed hosts, over https, and the bodies
 *  that cross the bridge as base64 arrive as a real request. */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkHost, fetchParams, runFetch } from '../main/net'

describe('checkHost', () => {
  const hosts = ['platform.syv.ai']

  it('lets a listed host through', () => {
    expect(() => checkHost(new URL('https://platform.syv.ai/v1/x'), hosts, 'T.app')).not.toThrow()
  })

  it('refuses a host the manifest does not list, naming the fix', () => {
    expect(() => checkHost(new URL('https://evil.example/'), hosts, 'T.app')).toThrow(
      /add "evil.example" to hosts in T.app\/app.yaml/,
    )
  })

  it('is exact: neither a subdomain nor the parent passes', () => {
    expect(() => checkHost(new URL('https://x.platform.syv.ai/'), hosts, 'T.app')).toThrow()
    expect(() => checkHost(new URL('https://syv.ai/'), hosts, 'T.app')).toThrow()
  })

  it('refuses plain http and credentials in the URL', () => {
    expect(() => checkHost(new URL('http://platform.syv.ai/'), hosts, 'T.app')).toThrow(/https/)
    expect(() => checkHost(new URL('https://a:b@platform.syv.ai/'), hosts, 'T.app')).toThrow()
  })

  it('refuses everything when the manifest lists no hosts', () => {
    expect(() => checkHost(new URL('https://platform.syv.ai/'), undefined, 'T.app')).toThrow()
  })
})

describe('fetchParams', () => {
  it('refuses a method fetch has no business with', () => {
    expect(() => fetchParams({ url: 'https://a.b/', method: 'CONNECT' })).toThrow()
  })

  it('refuses a body of an unknown kind', () => {
    expect(() => fetchParams({ url: 'https://a.b/', body: { kind: 'stream' } })).toThrow()
  })
})

describe('runFetch', () => {
  let server: Server
  let base: string
  let seen: { method?: string; type?: string; auth?: string; body: string }

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        seen = {
          method: req.method,
          type: req.headers['content-type'],
          auth: req.headers.authorization,
          body: Buffer.concat(chunks).toString('utf8'),
        }
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end('{"text":"hej"}')
      })
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
    const address = server.address()
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  })
  afterAll(() => server.close())

  it('sends a multipart form with its file and hands back status, headers and body', async () => {
    const answer = await runFetch(
      fetchParams({
        url: `${base}/v1/audio/transcriptions`,
        method: 'post',
        headers: { Authorization: 'Bearer k', 'Content-Type': 'multipart/form-data' },
        body: {
          kind: 'form',
          entries: [
            { name: 'model', value: 'syv-transcribe' },
            {
              name: 'file',
              filename: 'audio.webm',
              type: 'audio/webm',
              base64: Buffer.from('AUDIO').toString('base64'),
            },
          ],
        },
      }),
    )
    expect(seen.method).toBe('POST')
    expect(seen.auth).toBe('Bearer k')
    // fetch wrote the boundary; the app's bare content type was dropped.
    expect(seen.type).toMatch(/^multipart\/form-data; boundary=/)
    expect(seen.body).toContain('name="model"')
    expect(seen.body).toContain('syv-transcribe')
    expect(seen.body).toContain('filename="audio.webm"')
    expect(seen.body).toContain('AUDIO')
    expect(answer.status).toBe(201)
    expect(answer.headers['content-type']).toBe('application/json')
    expect(Buffer.from(answer.base64, 'base64').toString('utf8')).toBe('{"text":"hej"}')
  })

  it('says which host it could not reach', async () => {
    await expect(runFetch(fetchParams({ url: 'http://127.0.0.1:1/' }))).rejects.toThrow(
      /could not reach 127.0.0.1/,
    )
  })
})
