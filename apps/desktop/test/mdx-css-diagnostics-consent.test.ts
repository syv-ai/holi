import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { createMdxExternalNetworkFixture } from './fixtures/mdx-external-network'
import { within } from './fixtures/fixture-deadline'
import { gate, resourceRig } from './fixtures/mdx-router'

const source = "import './local.css'"

async function fixture() {
  const { mdx, acquire, root } = await resourceRig(true)
  await writeFile(join(root, 'local.css'), '@import "https://one.example/start.css";')
  const network = await createMdxExternalNetworkFixture()
  const owner = await acquire()
  onTestFinished(async () => {
    await mdx.releaseDiagnosticsLease(owner)
    await network.close()
  })
  const compile = (generation: number) => mdx.compile({ ...owner, generation, source })
  const approve = async (origin: string) => {
    const { pending } = await mdx.externalResources(owner)
    const request = pending.find((candidate) => candidate.origin === origin)
    expect(request).toBeDefined()
    await mdx.approveExternalResource({ ...owner, requestId: request!.id })
  }
  return { mdx, owner, network, compile, approve }
}

it('resolves nested CSS imports and binary assets from the final redirected stylesheet URL', async () => {
  const { network, compile, approve } = await fixture()
  network.routes.respond = (req, res) => {
    switch (req.url) {
      case '/start.css':
        res.writeHead(302, { Location: '/release/styles/main.css' })
        res.end()
        break
      case '/release/styles/main.css':
        res.setHeader('Content-Type', 'text/css')
        res.end('@import "nested/base.css"; a { background: url(../images/photo.png) }')
        break
      case '/release/styles/nested/base.css':
        res.setHeader('Content-Type', 'text/css')
        res.end('@font-face { font-family: fixture; src: url(../../fonts/body.woff2) }')
        break
      case '/release/fonts/body.woff2':
        res.setHeader('Content-Type', 'font/woff2')
        res.end(Buffer.from([0xff, 0xfe, 0x80]))
        break
      case '/release/images/photo.png':
        res.setHeader('Content-Type', 'image/png')
        res.end(Buffer.from([0x89, 0x50, 0xff]))
        break
      default:
        res.writeHead(404)
        res.end()
    }
  }
  expect(await compile(1)).not.toEqual([])
  await approve('https://one.example')
  expect(await compile(2)).toEqual([])
  expect(network.requests.map((req) => req.url).sort()).toEqual(
    [
      '/start.css',
      '/release/styles/main.css',
      '/release/styles/nested/base.css',
      '/release/fonts/body.woff2',
      '/release/images/photo.png',
    ].sort(),
  )
})

it.each([
  'image-set',
  '-webkit-image-set',
  String.raw`im\61 ge-set`,
  String.raw`-webkit-im\61 ge-set`,
])('requires fresh consent before contact with a string candidate in nested %s', async (name) => {
  const { mdx, owner, network, compile, approve } = await fixture()
  network.routes.respond = (req, res) => {
    if (req.url === '/start.css') {
      res.setHeader('Content-Type', 'text/css')
      res.end('@import "./nested.css";')
    } else if (req.url === '/nested.css') {
      res.setHeader('Content-Type', 'text/css')
      res.end(`a { background: ${name}("https://two.example/photo.png" 1x) }`)
    } else if (req.headers.host === 'two.example' && req.url === '/photo.png') {
      res.setHeader('Content-Type', 'image/png')
      res.end(Buffer.from([0x89, 0xff]))
    } else {
      res.writeHead(404)
      res.end()
    }
  }
  await compile(1)
  expect(network.dials).toEqual([])
  await approve('https://one.example')
  expect(await compile(2)).not.toEqual([])
  expect((await mdx.externalResources(owner)).pending).toMatchObject([
    { origin: 'https://two.example' },
  ])
  expect(network.dns4.mock.calls.map(([host]) => host)).not.toContain('two.example')
  expect(network.dns6.mock.calls.map(([host]) => host)).not.toContain('two.example')
  expect(network.names).not.toContain('two.example')
  expect(network.requests.map((req) => req.headers.host)).not.toContain('two.example')

  await approve('https://two.example')
  expect(await compile(3)).toEqual([])
  expect(network.requests.filter((req) => req.headers.host === 'two.example')).toHaveLength(1)
  expect((await mdx.externalResources(owner)).pending).toEqual([])
})

it('revoking consent cancels a streaming font discovered through the expanded CSS graph', async () => {
  const { mdx, owner, network, compile, approve } = await fixture()
  const receiving = gate()
  const closed = gate()
  network.routes.respond = (req, res) => {
    if (req.url === '/start.css') {
      res.setHeader('Content-Type', 'text/css')
      res.end('@import "./nested.css";')
    } else if (req.url === '/nested.css') {
      res.setHeader('Content-Type', 'text/css')
      res.end('@font-face { font-family: fixture; src: url(./body.woff2) }')
    } else if (req.url === '/body.woff2') {
      req.socket.once('close', () => closed.resolve())
      res.setHeader('Content-Type', 'font/woff2')
      res.write(Buffer.from([0xff, 0xfe]), () => receiving.resolve())
    } else {
      res.writeHead(404)
      res.end()
    }
  }
  await compile(1)
  await approve('https://one.example')
  // Attach the rejection handler before revocation can cancel the in-flight compile.
  const compiling = expect(compile(2)).rejects.toThrow()
  await within(receiving.promise, 3_000, 'receive nested font bytes')
  const { approved } = await mdx.externalResources(owner)
  const grant = approved.find((candidate) => candidate.origin === 'https://one.example')!
  await Promise.all([
    mdx.revokeExternalResource({ ...owner, grantId: grant.id }),
    within(closed.promise, 2_000, 'disconnect revoked font response'),
    compiling,
  ])
  const contacts = network.requests.length
  expect(await compile(3)).not.toEqual([])
  expect(network.requests).toHaveLength(contacts)
  expect(await mdx.externalResources(owner)).toMatchObject({
    approved: [],
    pending: [{ origin: 'https://one.example' }],
  })
})
