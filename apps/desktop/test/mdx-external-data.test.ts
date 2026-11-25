import { Resolver } from 'node:dns/promises'
import type { ServerResponse } from 'node:http'
import os, { type NetworkInterfaceInfo } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchMdxExternalData,
  fetchMdxExternalResourceData,
  MdxExternalDataError,
} from '../src/main/mdx-external-data'

import { createMdxExternalNetworkFixture } from './fixtures/mdx-external-network'

const source = 'export default 42\n'
const v4 = '93.184.216.34'
const v6 = '2606:2800:220:1:248:1893:25c8:1946'
const redirectTo = (res: ServerResponse, location: string) => {
  res.writeHead(302, {
    Location: location,
    'Content-Type': 'text/html',
    'Set-Cookie': 'session=not-for-the-next-hop',
  })
  res.end('<p>Redirecting</p>')
}

function interfaceAddress(address: string): NetworkInterfaceInfo {
  const adapter = { address, mac: '02:00:00:00:00:01', internal: false }
  return address.includes(':')
    ? {
        ...adapter,
        family: 'IPv6',
        netmask: 'ffff:ffff:ffff:ffff::',
        cidr: `${address}/64`,
        scopeid: 0,
      }
    : { ...adapter, family: 'IPv4', netmask: '255.255.255.0', cidr: `${address}/24` }
}

let network: Awaited<ReturnType<typeof createMdxExternalNetworkFixture>>
beforeEach(async () => {
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    lo0: [
      {
        ...interfaceAddress('127.0.0.1'),
        internal: true,
        netmask: '255.0.0.0',
        cidr: '127.0.0.1/8',
      },
    ],
  })
  network = await createMdxExternalNetworkFixture()
})
afterEach(async () => {
  vi.useRealTimers()
  await network?.close()
  vi.restoreAllMocks()
})

const fetchResource = (
  kind: 'module' | 'css' | 'asset',
  overrides: Partial<Parameters<typeof fetchMdxExternalData>[0]> = {},
) =>
  fetchMdxExternalResourceData({
    url: network.entryURL.replace(
      '.js',
      kind === 'css' ? '.css' : kind === 'asset' ? '.png' : '.js',
    ),
    signal: new AbortController().signal,
    assertAccess: () => true,
    kind,
    ...overrides,
  })

const fetchText = (overrides: Partial<Parameters<typeof fetchMdxExternalData>[0]> = {}) =>
  fetchMdxExternalData({
    url: network.entryURL,
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

function expectNoDial() {
  expect(network.dials).toEqual([])
  expect(network.names).toEqual([])
  expect(network.requests).toEqual([])
}

function expectNoContact() {
  expect(network.dns4).not.toHaveBeenCalled()
  expect(network.dns6).not.toHaveBeenCalled()
  expectNoDial()
}

describe('fetchMdxExternalResourceData', () => {
  it('returns CSS text and exact non-UTF8 asset bytes, rejecting mismatched MIME', async () => {
    network.routes.respond = (_, res) => {
      res.setHeader('Content-Type', 'text/css')
      res.end('body { color: red }')
    }
    await expect(fetchResource('css')).resolves.toMatchObject({ text: 'body { color: red }' })

    network.routes.respond = (_, res) => {
      res.setHeader('Content-Type', 'image/png')
      res.end(Buffer.from([0, 255, 128]))
    }
    const image = await fetchResource('asset')
    expect([...image.bytes]).toEqual([0, 255, 128])
    expect(image).not.toHaveProperty('text')

    network.routes.respond = (_, res) => {
      res.setHeader('Content-Type', 'text/javascript')
      res.end('not css')
    }
    await expect(fetchResource('css')).rejects.toMatchObject({ code: 'unsupported-format' })
  })

  it('revalidates redirected responses using the requested resource kind', async () => {
    network.routes.respond = (req, res) => {
      if (req.url === '/index.png') return redirectTo(res, 'https://two.example/image.png')
      res.setHeader('Content-Type', 'text/css')
      res.end('body {}')
    }
    await expect(fetchResource('asset')).rejects.toMatchObject({ code: 'unsupported-format' })
    expect(network.requests.map((req) => [req.headers.host, req.url])).toEqual([
      ['one.example', '/index.png'],
      ['two.example', '/image.png'],
    ])
  })
})

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

  it.each([
    { name: 'IPv4', assigned: v4, a: [v4], aaaa: [v6] },
    {
      name: 'IPv6 in another spelling, after an eligible IPv4 answer',
      assigned: '2606:4700::abcd',
      a: [v4],
      aaaa: ['2606:4700:0000:0000:0000:0000:0000:ABCD'],
    },
    {
      name: 'IPv4 with an IPv4-mapped interface alias, after an eligible IPv4 answer',
      assigned: '::ffff:8.8.4.4',
      a: [v4, '8.8.4.4'],
      aaaa: [v6],
    },
  ])(
    'rejects machine-assigned public $name without contacting TLS',
    async ({ assigned, a, aaaa }) => {
      vi.mocked(os.networkInterfaces).mockReturnValue({ en0: [interfaceAddress(assigned)] })
      network.dns4.mockResolvedValue(a)
      network.dns6.mockResolvedValue(aaaa)
      await expect(fetchText()).rejects.toMatchObject({ code: 'unsafe-address' })
      expectNoDial()
    },
  )

  it('rechecks local assignments after resolving a redirect', async () => {
    network.routes.respond = (_, res) => redirectTo(res, 'https://two.example/module.js')
    network.dns4.mockImplementation(async (hostname) => {
      if (hostname === 'two.example') {
        vi.mocked(os.networkInterfaces).mockReturnValue({ en0: [interfaceAddress(v4)] })
      }
      return [v4]
    })
    await expect(fetchText()).rejects.toMatchObject({ code: 'unsafe-address' })
    expect(network.dials).toEqual([v4])
    expect(network.names).toEqual(['one.example'])
    expect(network.requests.map((req) => req.headers.host)).toEqual(['one.example'])
  })

  it('does not dial if interface enumeration fails', async () => {
    vi.mocked(os.networkInterfaces).mockImplementation(() => {
      throw new Error('interface details')
    })
    await expect(fetchText()).rejects.toMatchObject({ code: 'network' })
    expectNoDial()
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

  it.each([
    ['https://%74wo.example/module.js', 'unsafe-url'],
    ['https://two.example/data%2Ejson', 'unsupported-format'],
    ['https://two.example/style.css', 'unsupported-format'],
    ['https://two.example/page.html', 'unsupported-format'],
    ['https://two.example/photo.webp', 'unsupported-format'],
    ['https://two.example/native.node', 'unsupported-format'],
  ])('rejects redirect destination %s before authorization or contact', async (url, code) => {
    network.routes.respond = (_, res) => redirectTo(res, url)
    const assertAccess = vi.fn((_origin: string) => true)
    await expect(fetchText({ assertAccess })).rejects.toMatchObject({ code })
    expect(assertAccess.mock.calls.every(([origin]) => origin === 'https://one.example')).toBe(true)
    expect(network.dns4).not.toHaveBeenCalledWith('two.example')
    expect(network.dns6).not.toHaveBeenCalledWith('two.example')
    expect(network.dials).toEqual([v4])
    expect(network.requests).toHaveLength(1)
  })

  it('follows authorized redirects over pinned TLS and returns the relative-import base', async () => {
    vi.mocked(os.networkInterfaces).mockReturnValue({
      en0: [interfaceAddress('93.184.216.35'), interfaceAddress('2606:2800:220:1::1')],
    })
    network.dns4.mockImplementation(async (host) => {
      if (host === 'one.example') return [v4]
      throw { code: 'ENODATA' }
    })
    network.dns6.mockResolvedValue([v6])
    network.routes.peerAddress = (address) =>
      address === v4 ? `::ffff:${v4}` : '2606:2800:0220:0001:0248:1893:25C8:1946'
    network.routes.respond = (req, res) => {
      if (req.headers.host === 'one.example') redirectTo(res, 'https://two.example/pkg@5.1.5')
      else if (req.url === '/pkg@5.1.5') redirectTo(res, './modules/final.js?version=1')
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

  it.each([
    ['the actual loopback peer', null],
    ['a simulated public peer that was not selected', '8.8.8.8'],
  ])('does not send HTTP to %s, even with a valid certificate', async (_, peer) => {
    network.routes.peerAddress = peer === null ? null : () => peer
    await expect(fetchText()).rejects.toMatchObject({ code: 'unsafe-peer' })
    expect(network.names).toEqual(['one.example'])
    expect(network.requests).toEqual([])
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

  it.each(['Application/JavaScript; charset="UTF-8"', 'application/ecmascript'])(
    'fetches extensionless module source served as %s',
    async (contentType) => {
      network.routes.respond = (_, res) => {
        res.setHeader('Content-Type', contentType)
        res.end(source)
      }
      const url = 'https://one.example/module'
      await expect(fetchText({ url })).resolves.toEqual({ url, text: source })
    },
  )

  it.each([false, true])('accepts Raw GitHub plain source with redirect=%s', async (redirect) => {
    const url = 'https://raw.githubusercontent.com/example/repo/main/module.js'
    network.routes.respond = (req, res) => {
      if (req.headers.host !== 'raw.githubusercontent.com') return redirectTo(res, url)
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.end(source)
    }
    await expect(fetchText({ url: redirect ? network.entryURL : url })).resolves.toEqual({
      url,
      text: source,
    })
  })

  it('does not carry the Raw GitHub plain-text exception through a redirect', async () => {
    network.routes.respond = (req, res) => {
      if (req.headers.host === 'raw.githubusercontent.com')
        return redirectTo(res, 'https://two.example/module.js')
      res.setHeader('Content-Type', 'text/plain')
      res.write(source)
    }
    await expect(
      fetchText({ url: 'https://raw.githubusercontent.com/example/repo/main/module.js' }),
    ).rejects.toMatchObject({ code: 'unsupported-format' })
    expect(network.requests.map((req) => req.headers.host)).toEqual([
      'raw.githubusercontent.com',
      'two.example',
    ])
  })

  it.each([
    { label: 'plain text outside Raw GitHub', contentType: 'text/plain; charset=utf-8' },
    { label: 'JSON', contentType: 'application/json' },
    { label: 'CSS', contentType: 'text/css' },
    { label: 'HTML', contentType: 'text/html' },
    { label: 'binary data', contentType: 'application/octet-stream' },
    { label: 'missing', contentType: undefined },
    { label: 'malformed', contentType: 'text/javascript; private-header-secret' },
    { label: 'coalesced', contentType: 'text/javascript; charset=utf-8, application/json' },
    { label: 'duplicate', contentType: ['text/javascript', 'application/json'] },
  ])(
    'rejects $label Content-Type without waiting for the response body',
    async ({ contentType }) => {
      network.routes.respond = (_, res) => {
        if (contentType === undefined) res.removeHeader('Content-Type')
        else res.setHeader('Content-Type', contentType)
        // Keep the body open: a reader would stall here, not receive an unsupported-format error.
        res.write('42 /* private-body-secret */')
      }
      const error = await fetchText({
        url: 'https://one.example/module?private-query-secret',
      }).catch((error: unknown) => error)
      expect(error).toMatchObject({ code: 'unsupported-format' })
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toMatch(
        /private-(body|header|query)-secret/,
      )
    },
  )

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
