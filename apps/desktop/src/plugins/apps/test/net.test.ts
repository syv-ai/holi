/** `holi.fetch`'s main side: only an app granted `network`, only listed
 *  hosts by name, never this machine or its network, over https, no
 *  redirects, a capped size each way, and the bodies that cross the bridge as
 *  base64 arrive as a real request. */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { emptyVaultSnapshot } from '@holi/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CapabilityError } from '../../../main/capabilities/error'
import { createCapabilityRegistry } from '../../../main/capabilities/registry'
import { noCoreServices } from '../../../main/capabilities/services'
import { admitApps, type GrantStatus } from '../main/grants'
import {
  checkAddress,
  checkHost,
  fetchParams,
  isPrivateAddress,
  MAX_FETCH_BYTES,
  netCapabilities,
  runFetch,
} from '../main/net'

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: CapabilityError) => ({ code: e.code, message: e.message }),
  )

describe('net.fetch at the app door', () => {
  const registry = createCapabilityRegistry()
  registry.register(['net'], netCapabilities())
  const ctx = {
    remote: 'o/r',
    root: '/nowhere',
    bundle: 'T.app',
    snapshot: async () => emptyVaultSnapshot(),
    claims: async () => [],
    core: noCoreServices(),
  }
  const admitWith = (status: GrantStatus) =>
    admitApps({ status: async () => status, grant: async () => true })
  const call = (status: GrantStatus) =>
    registry.run('net.fetch', 'app', ctx, { url: 'https://platform.syv.ai/' }, admitWith(status))

  it('is refused to an app that does not declare network', async () => {
    expect(await refusal(call({ codeHash: 'h', affordances: [] }))).toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('dangerously-allow: [network]'),
    })
  })

  it('is refused to an app whose network the person has not approved', async () => {
    expect(
      await refusal(
        call({ codeHash: 'h', affordances: [{ affordance: 'network', granted: false }] }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('not approved') })
  })
})

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

  it('refuses an address or this machine, even when listed', () => {
    const listed = ['127.0.0.1', '[::1]', '10.0.0.1', 'localhost', 'x.localhost']
    for (const url of ['https://127.0.0.1/', 'https://[::1]/', 'https://10.0.0.1/']) {
      expect(() => checkHost(new URL(url), listed, 'T.app')).toThrow(/by name/)
    }
    // A decimal address is still an address: the URL parser writes it out.
    expect(() => checkHost(new URL('https://2130706433/'), listed, 'T.app')).toThrow(/by name/)
    expect(() => checkHost(new URL('https://localhost/'), listed, 'T.app')).toThrow(/localhost/)
    expect(() => checkHost(new URL('https://x.localhost/'), listed, 'T.app')).toThrow()
  })
})

describe('checkAddress', () => {
  it('knows this machine, private networks and link-local from the internet', () => {
    for (const a of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateAddress(a), a).toBe(true)
    }
    for (const a of ['93.184.216.34', '2606:4700::6810:85e5', '::ffff:93.184.216.34']) {
      expect(isPrivateAddress(a), a).toBe(false)
    }
  })

  it('refuses a listed name that resolves into this network', async () => {
    const resolve = async () => ['93.184.216.34', '192.168.0.10']
    expect(await refusal(checkAddress('api.example.com', resolve))).toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('lets a name with only public addresses through', async () => {
    await expect(
      checkAddress('api.example.com', async () => ['93.184.216.34']),
    ).resolves.toBeUndefined()
  })

  it('says when the name does not resolve', async () => {
    const resolve = async () => {
      throw new Error('ENOTFOUND')
    }
    expect(await refusal(checkAddress('nope.example', resolve))).toMatchObject({
      code: 'UNAVAILABLE',
      message: expect.stringContaining('nope.example'),
    })
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
      if (req.url === '/moved') {
        res.writeHead(302, { location: 'http://169.254.169.254/' })
        res.end()
        return
      }
      if (req.url === '/says-huge') {
        // Declares more than the cap, and is refused before any of it is read.
        res.writeHead(200, { 'content-length': String(MAX_FETCH_BYTES + 1) })
        res.write('x')
        return
      }
      if (req.url === '/streams-forever') {
        // No length: refused once what arrived passes the cap.
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        const chunk = Buffer.alloc(1024 * 1024)
        const more = (): void => {
          while (!res.destroyed && res.write(chunk));
          if (!res.destroyed) res.once('drain', more)
        }
        res.on('close', () => res.destroy())
        more()
        return
      }
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
  afterAll(() => {
    server.closeAllConnections()
    server.close()
  })

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

  it('does not follow a redirect, and says so', async () => {
    await expect(runFetch(fetchParams({ url: `${base}/moved` }))).rejects.toThrow(
      /answered with a redirect/,
    )
  })

  it('refuses an answer declared larger than the cap', async () => {
    await expect(runFetch(fetchParams({ url: `${base}/says-huge` }))).rejects.toThrow(
      /answer is too large/,
    )
  })

  it('stops reading an answer once it passes the cap', async () => {
    await expect(runFetch(fetchParams({ url: `${base}/streams-forever` }))).rejects.toThrow(
      /answer is too large/,
    )
  }, 30_000)

  it('caps the request body as a whole, not each part', async () => {
    // Each part is under the cap; the two together are over it.
    const part = 'A'.repeat(Math.ceil((MAX_FETCH_BYTES * 0.6 * 4) / 3))
    const params = fetchParams({
      url: `${base}/`,
      method: 'POST',
      body: {
        kind: 'form',
        entries: [
          { name: 'a', filename: 'a', type: '', base64: part },
          { name: 'b', filename: 'b', type: '', base64: part },
        ],
      },
    })
    await expect(runFetch(params)).rejects.toThrow(/body is too large/)
  })

  it('says which host it could not reach', async () => {
    await expect(runFetch(fetchParams({ url: 'http://127.0.0.1:1/' }))).rejects.toThrow(
      /could not reach 127.0.0.1/,
    )
  })
})
