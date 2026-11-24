import { Resolver } from 'node:dns/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:https'
import { connect } from 'node:net'
import tls from 'node:tls'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchMdxExternalData, MdxExternalDataError } from '../src/main/mdx-external-data'

// Public test fixture, valid only for the reserved names one.example and two.example.
const key = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIFbtFoP/7xss62YuffZkAvn8+1jm0FFte4BkcJHb2csJoAoGCCqGSM49
AwEHoUQDQgAEkRXrvSG6dtk5PvhH83B7A4v1gEsMaY8hWhT8QamyRMMM8GVw6otU
BbznjRXHeAwJ8up9RufaieRZXsD/P5oTcQ==
-----END EC PRIVATE KEY-----`
const cert = `-----BEGIN CERTIFICATE-----
MIIBmTCCAT+gAwIBAgIUQZtLp4oDUk+bjK1296/7FehGpjswCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLb25lLmV4YW1wbGUwIBcNMjAwMTAxMDAwMDAwWhgPMjEyMDAx
MDEwMDAwMDBaMBYxFDASBgNVBAMMC29uZS5leGFtcGxlMFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAEkRXrvSG6dtk5PvhH83B7A4v1gEsMaY8hWhT8QamyRMMM8GVw
6otUBbznjRXHeAwJ8up9RufaieRZXsD/P5oTcaNpMGcwHQYDVR0OBBYEFB8YkXjZ
pVmCONZBKYHteCFaxXZjMCMGA1UdEQQcMBqCC29uZS5leGFtcGxlggt0d28uZXhh
bXBsZTAMBgNVHRMBAf8EAjAAMBMGA1UdJQQMMAoGCCsGAQUFBwMBMAoGCCqGSM49
BAMCA0gAMEUCIDXb+CajVPWP/QwXm0ZUU2brUZMLtY94EqKHuI3NRmSrAiEA8K6d
a2l11piAxwsSy2hOah7eWqscrFppzWf8e8CLm48=
-----END CERTIFICATE-----`

const source = 'export default 42\n'
const v4 = '93.184.216.34'
const v6 = '2606:2800:220:1:248:1893:25c8:1946'
const entry = 'https://one.example/index.js'
const redirectTo = (res: ServerResponse, location: string) => {
  res.writeHead(302, { Location: location, 'Set-Cookie': 'session=not-for-the-next-hop' })
  res.end('not module text')
}

async function fixture() {
  const dns4 = vi.spyOn(Resolver.prototype, 'resolve4').mockResolvedValue([v4])
  const dns6 = vi.spyOn(Resolver.prototype, 'resolve6').mockRejectedValue({ code: 'ENODATA' })
  const requests: IncomingMessage[] = []
  const names: string[] = []
  const dials: (string | undefined)[] = []
  const routes = {
    respond: (_: IncomingMessage, res: ServerResponse) => {
      res.end(source)
    },
    handshake: () => {},
  }
  const context = tls.createSecureContext({ key, cert })
  const server = createServer(
    {
      key,
      cert,
      SNICallback: (name, done) => {
        names.push(name)
        routes.handshake()
        done(null, context)
      },
    },
    (req, res) => {
      requests.push(req)
      routes.respond(req, res)
    },
  )
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject).listen(0, '127.0.0.1', resolve)
  })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('HTTPS fixture has no TCP address')
  const tlsConnect = tls.connect
  // Route the TCP leg to the fixture and trust only its certificate. Keep Node's HTTPS and
  // TLS implementation (including SNI and hostname verification), and observe the intended dial.
  vi.spyOn(tls, 'connect').mockImplementation((options: tls.ConnectionOptions | number) => {
    if (typeof options !== 'object') throw new Error('Expected HTTPS connection options')
    dials.push(options.host)
    return tlsConnect({ ...options, ca: cert, socket: connect(addr.port, '127.0.0.1') })
  })
  return {
    dns4,
    dns6,
    requests,
    names,
    dials,
    routes,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}

let network: Awaited<ReturnType<typeof fixture>>
beforeEach(async () => {
  network = await fixture()
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  await network?.close()
})

const fetchText = (overrides: Partial<Parameters<typeof fetchMdxExternalData>[0]> = {}) =>
  fetchMdxExternalData({
    url: entry,
    signal: new AbortController().signal,
    assertAccess: () => true,
    ...overrides,
  })

function stalledDns() {
  const pending = new Set<() => void>()
  let notify!: () => void
  const started = new Promise<void>((resolve) => {
    notify = resolve
  })
  const stall = () =>
    new Promise<string[]>((_, reject) => {
      pending.add(() => reject({ code: 'ECANCELLED' }))
      notify()
    })
  network.dns4.mockImplementation(stall)
  network.dns6.mockImplementation(stall)
  vi.spyOn(Resolver.prototype, 'cancel').mockImplementation(() => {
    for (const cancel of pending) cancel()
    pending.clear()
  })
  return { started, pending }
}

function expectNoContact() {
  expect(network.dns4).not.toHaveBeenCalled()
  expect(network.dns6).not.toHaveBeenCalled()
  expect(network.dials).toEqual([])
}

describe('fetchMdxExternalData', () => {
  it('reports the canonical origin needing consent without DNS or sockets', async () => {
    const outcome = fetchText({
      url: 'HTTPS://ONE.example:443/package.js?secret=not-in-errors',
      assertAccess: () => false,
    })
    await expect(outcome).rejects.toBeInstanceOf(MdxExternalDataError)
    await expect(outcome).rejects.toMatchObject({
      code: 'consent-needed',
      origin: 'https://one.example',
    })
    expectNoContact()
  })

  it.each([
    'http://one.example/index.js',
    'https://one.example:8443/index.js',
    'https://user:secret@one.example/index.js',
    'https://@one.example/index.js',
    'https://93.184.216.34/index.js',
    'https://[2606:4700::1]/index.js',
    'https://0x7f000001/index.js',
    'https://0177.0.0.1/index.js',
    'https://%6fne.example/index.js',
    'https:///one.example/index.js',
    'https://one.example\\index.js',
    'https://one.example\t/index.js',
  ])('rejects unsafe URL syntax before DNS or sockets: %s', async (url) => {
    await expect(fetchText({ url })).rejects.toMatchObject({ code: 'unsafe-url' })
    expectNoContact()
  })

  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.42',
    '127.42.0.1',
    '169.254.169.254',
    '192.0.2.1',
    '224.0.0.1',
    '240.0.0.1',
    '::',
    '::1',
    '::ffff:5db8:d822',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '2002:7f00:1::',
    '3fff::1',
  ])('rejects a non-public DNS answer alongside a public answer: %s', async (ip) => {
    if (ip.includes(':')) network.dns6.mockResolvedValue([ip])
    else network.dns4.mockResolvedValue([v4, ip])
    await expect(fetchText()).rejects.toMatchObject({ code: 'unsafe-address' })
    expect(network.dials).toEqual([])
  })

  it('makes no socket contact if access has been revoked while the lookup runs', async () => {
    let allowed = true
    network.dns6.mockImplementation(async () => {
      allowed = false
      return [v6]
    })
    await expect(fetchText({ assertAccess: async () => allowed })).rejects.toMatchObject({
      code: 'consent-needed',
      origin: 'https://one.example',
    })
    expect(network.dials).toEqual([])
  })

  it('does not look up or connect to a redirect destination that needs consent', async () => {
    network.routes.respond = (_, res) => redirectTo(res, 'https://two.example/modules/entry.js')
    await expect(
      fetchText({ assertAccess: (origin) => origin === 'https://one.example' }),
    ).rejects.toMatchObject({
      code: 'consent-needed',
      origin: 'https://two.example',
    })
    expect(network.dns4).not.toHaveBeenCalledWith('two.example')
    expect(network.dns6).not.toHaveBeenCalledWith('two.example')
    expect(network.dials).toEqual([v4])
  })

  it('follows authorized redirects over pinned TLS and returns the relative-import base', async () => {
    network.dns4.mockImplementation(async (host) => {
      if (host === 'one.example') return [v4]
      throw { code: 'ENODATA' }
    })
    network.dns6.mockResolvedValue([v6])
    network.routes.respond = (req, res) => {
      if (req.headers.host === 'one.example') redirectTo(res, 'https://two.example/first.js')
      else if (req.url === '/first.js') redirectTo(res, './modules/final.js?version=1')
      else res.end(source)
    }
    const result = await fetchText()
    expect(result).toEqual({ url: 'https://two.example/modules/final.js?version=1', text: source })
    expect(new URL('./child.js', result.url).href).toBe('https://two.example/modules/child.js')
    expect(network.dials).toEqual([v4, v6, v6])
    expect(network.names).toEqual(['one.example', 'two.example', 'two.example'])
    for (const req of network.requests) {
      expect(req.method).toBe('GET')
      expect(req.headers['accept-encoding']).toBe('identity')
      expect(req.headers).not.toHaveProperty('cookie')
      expect(req.headers).not.toHaveProperty('authorization')
      expect(req.headers).not.toHaveProperty('referer')
    }
  })

  it('does not send an HTTP request if consent is revoked during TLS setup', async () => {
    let allowed = true
    network.routes.handshake = () => {
      allowed = false
    }
    await expect(fetchText({ assertAccess: () => allowed })).rejects.toMatchObject({
      code: 'consent-needed',
      origin: 'https://one.example',
    })
    expect(network.requests).toEqual([])
  })

  it('refuses a certificate for a different hostname before sending HTTP', async () => {
    await expect(fetchText({ url: 'https://wrong.example/index.js' })).rejects.toMatchObject({
      code: 'network',
    })
    expect(network.names).toEqual(['wrong.example'])
    expect(network.requests).toEqual([])
  })

  it('bounds a redirect loop', async () => {
    network.routes.respond = (_, res) => redirectTo(res, '/index.js')
    await expect(fetchText()).rejects.toMatchObject({ code: 'redirect' })
    expect(network.requests.length).toBeLessThanOrEqual(4)
  })

  it('bounds chunked response bytes without trusting Content-Length', async () => {
    network.routes.respond = (_, res) => {
      res.write(Buffer.alloc(256 * 1024, 'x'))
      res.end('more')
    }
    await expect(fetchText()).rejects.toMatchObject({ code: 'too-large' })
  })

  it('returns a sanitized error rather than exposing an HTTP error body', async () => {
    network.routes.respond = (_, res) => {
      res.writeHead(401).end('private response body')
    }
    const error = await fetchText().catch((error: unknown) => error)
    expect(error).toMatchObject({ code: 'response' })
    expect(String(error)).not.toContain('private response body')
  })

  it('cancels pending DNS queries on abort without opening a socket', async () => {
    const { started, pending } = stalledDns()
    const controller = new AbortController()
    const result = expect(fetchText({ signal: controller.signal })).rejects.toMatchObject({
      code: 'aborted',
    })
    await started
    controller.abort(new Error('caller details'))
    await result
    expect(pending.size).toBe(0)
    expect(network.dials).toEqual([])
  })

  it('times out a stalled lookup and cancels it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { started, pending } = stalledDns()
    const result = expect(fetchText()).rejects.toMatchObject({ code: 'timeout' })
    await started
    await vi.advanceTimersByTimeAsync(60_000)
    await result
    expect(pending.size).toBe(0)
    expect(network.dials).toEqual([])
  })

  it('closes the response connection when the caller cancels', async () => {
    let received!: () => void
    let closed!: () => void
    const receiving = new Promise<void>((resolve) => {
      received = resolve
    })
    const closing = new Promise<void>((resolve) => {
      closed = resolve
    })
    network.routes.respond = (_, res) => {
      res.on('close', closed)
      res.write('partial module text')
      received()
    }
    const controller = new AbortController()
    const result = expect(fetchText({ signal: controller.signal })).rejects.toMatchObject({
      code: 'aborted',
    })
    await receiving
    controller.abort()
    await result
    await closing
  })
})
