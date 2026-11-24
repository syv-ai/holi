import type { ServerResponse } from 'node:http'
import { Agent, createServer, request } from 'node:https'
import { connect } from 'node:net'
import tls from 'node:tls'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { observeMdxNativeNetwork } from '../scripts/mdx-native-network-observation'

// Public unit-fixture key and certificate; trusted only by this modeled loopback route.
const key = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgwmxK2hSKqa+ST7kd
ZZBOjdKRPFcAiRa4Ro8G9md6h5ahRANCAAQFl5e7K3X7rP2D1Gw1MbZWFYFrio5T
ii9gMJRQfJVlpaj4GquPWon2zsqw6QOWWWffdSSVUTtZJNw8pyOphVoR
-----END PRIVATE KEY-----`
const cert = `-----BEGIN CERTIFICATE-----
MIIBijCCATGgAwIBAgIBATAKBggqhkjOPQQDAjASMRAwDgYDVQQDDAdlc20ucnVu
MCAXDTIwMDEwMTAwMDAwMFoYDzIxMjYwMTAxMDAwMDAwWjASMRAwDgYDVQQDDAdl
c20ucnVuMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEBZeXuyt1+6z9g9RsNTG2
VhWBa4qOU4ovYDCUUHyVZaWo+Bqrj1qJ9s7KsOkDllln33UklVE7WSTcPKcjqYVa
EaN2MHQwDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4AwEwYDVR0lBAwwCgYI
KwYBBQUHAwEwPwYDVR0RBDgwNoIZcmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbYIH
ZXNtLnJ1boIQY2RuLmpzZGVsaXZyLm5ldDAKBggqhkjOPQQDAgNHADBEAiBknNp5
3pRY3DZfOhn6MYnITmD3oNZ8WjqZmp/p9YRgaAIgQGUmDnVPG/bqNtSoGTGxN+rf
XnrQ1Cx2kjAyFEkuceg=
-----END CERTIFICATE-----`

const sha = 'a'.repeat(40)
const raw = 'raw.githubusercontent.com'
const esm = 'esm.run'
const cdn = 'cdn.jsdelivr.net'
const rawPath = `/syv-ai/holi/${sha}/apps/desktop/scripts/fixtures/mdx-external`
const esmPath = '/nanoid@5.1.5/url-alphabet/index.js'
const cdnPath = '/npm/nanoid@5.1.5/url-alphabet/index.js/+esm'
const cdnUrl = `https://${cdn}${cdnPath}`
const streamPath = '/npm/lodash@4.17.21/lodash.min.js'

let observer: ReturnType<typeof observeMdxNativeNetwork>
let server: ReturnType<typeof createServer>
let respond: (res: ServerResponse) => void

beforeEach(async () => {
  respond = (res) => res.end('module data')
  server = createServer({ key, cert }, (_, res) => respond(res))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject).listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback fixture port')
  const tlsConnect = tls.connect
  // MODELED: substitute the TCP route and reported peer only in this unit case.
  // TLS certificate/SNI validation and HTTP diagnostics still run over a real socket.
  vi.spyOn(tls, 'connect').mockImplementation((options: tls.ConnectionOptions | number) => {
    if (typeof options !== 'object') throw new Error('Expected HTTPS connection options')
    const socket = tlsConnect({ ...options, ca: cert, socket: connect(address.port, '127.0.0.1') })
    socket.once('secureConnect', () => {
      Object.defineProperties(socket, {
        remoteAddress: { value: options.host },
        remotePort: { value: options.port },
      })
    })
    return socket
  })
  observer = observeMdxNativeNetwork(sha)
})

afterEach(async () => {
  observer?.close()
  vi.restoreAllMocks()
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
    server.closeAllConnections()
  })
})

async function send(
  host: string,
  path: string,
  status = 200,
  location?: string | string[],
  sni = host,
) {
  respond = (res) => {
    if (location) res.setHeader('Location', location)
    res.writeHead(status).end('fixture body')
  }
  const agent = new Agent({ keepAlive: false, maxCachedSessions: 0 })
  try {
    await new Promise<void>((resolve, reject) => {
      const req = request({
        agent,
        hostname: '93.184.216.34', // Modeled selected public address; no live DNS or egress.
        port: 443,
        servername: sni,
        rejectUnauthorized: true,
        path,
        headers: { Host: host, Connection: 'close' },
      })
      // Match production: only end the request after its TLS handshake.
      req.once('socket', (socket) => socket.once('secureConnect', () => req.end()))
      req.once('error', reject)
      req.once('response', (response) => {
        response.once('error', reject)
        response.once('end', resolve)
        response.resume()
      })
    })
  } finally {
    agent.destroy()
  }
  return {
    request: observer.network.requests.at(-1)?.route,
    response: observer.network.responses.at(-1)?.route,
  }
}

it('labels only the pinned fixture requests and the exact observed CDN handoff (modeled transport)', async () => {
  const cases = [
    [raw, `${rawPath}/entry.js`, 'entry'],
    [raw, `${rawPath}/relative.js`, 'relative'],
    [raw, `${rawPath.replace(sha, 'b'.repeat(40))}/entry.js`, 'unexpected'],
    [raw, `${rawPath}/subdir/relative.js`, 'unexpected'],
    [raw, `${rawPath}/entry.js?private-query=value`, 'unexpected'],
    [raw, `${rawPath}/entry.js?`, 'unexpected'],
    [cdn, cdnPath, 'unexpected'],
  ] as const
  for (const [host, path, label] of cases) {
    expect(await send(host, path)).toEqual({ request: label, response: label })
  }
  expect(await send(esm, esmPath, 302, `//${cdn}${cdnPath}`)).toEqual({
    request: 'redirect',
    response: 'redirect',
  })
  for (const path of ['/npm/unrelated@1.2.3/+esm', `${cdnPath}?private-query=value`]) {
    expect(await send(cdn, path)).toEqual({ request: 'unexpected', response: 'unexpected' })
  }
  expect(await send(cdn, cdnPath)).toEqual({ request: 'cdn', response: 'cdn' })
  expect(await send(cdn, cdnPath)).toEqual({ request: 'unexpected', response: 'unexpected' })
  expect(await send(cdn, streamPath)).toEqual({ request: 'stream', response: 'stream' })

  const receipt = JSON.stringify(observer.network)
  expect(receipt).not.toContain(rawPath)
  expect(receipt).not.toContain(esmPath)
  expect(receipt).not.toContain(cdnPath)
  expect(receipt).not.toContain('private-query')
})

it('does not credit a CDN request for a different redirect source or invalid Location (modeled transport)', async () => {
  for (const [path, sni] of [
    ['/nanoid@5.1.4/url-alphabet/index.js', esm],
    [`${esmPath}?private-query=value`, esm],
    [esmPath, cdn],
  ] as const) {
    expect(await send(esm, path, 302, cdnUrl, sni)).toEqual({
      request: 'unexpected',
      response: 'unexpected',
    })
  }
  for (const location of [
    cdnUrl.replace('https:', 'http:'),
    cdnUrl.replace(cdn, `${cdn}:8443`),
    cdnUrl.replace(cdn, `synthetic-user:private-credential@${cdn}`),
    cdnUrl.replace(cdn, raw),
    cdnUrl.replace('5.1.5', '5.1.4'),
    `${cdnUrl}?private-query=value`,
    [cdnUrl, cdnUrl],
  ]) {
    expect(await send(esm, esmPath, 302, location)).toEqual({
      request: 'redirect',
      response: 'unexpected',
    })
    expect(await send(cdn, cdnPath)).toEqual({ request: 'unexpected', response: 'unexpected' })
  }
  expect(JSON.stringify(observer.network)).not.toMatch(/private-(credential|query)/)
})
