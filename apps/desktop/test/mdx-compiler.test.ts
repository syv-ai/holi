import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  sessions: [] as FakeSession[],
  guests: [] as FakeGuest[],
  reads: vi.fn(),
  BrowserWindow: vi.fn(),
  fromPartition: vi.fn(),
  hangLoadNext: false,
  failLoadNext: false,
  destroyedContentsId: -2,
}))

class FakeSession extends EventEmitter {
  webRequest = { onBeforeRequest: vi.fn(), onHeadersReceived: vi.fn() }
  protocol = { handle: vi.fn(), unhandle: vi.fn() }
  clearStorageData = vi.fn(async () => undefined)
  clearCache = vi.fn(async () => undefined)
  setPermissionRequestHandler = vi.fn()
  setPermissionCheckHandler = vi.fn()
  setDisplayMediaRequestHandler = vi.fn()
  constructor() {
    super()
    state.sessions.push(this)
  }
}

let nextGuestId = 1

class FakeGuest extends EventEmitter {
  webContents = Object.assign(new EventEmitter(), {
    id: nextGuestId++,
    setWindowOpenHandler: vi.fn(),
    executeJavaScript: vi.fn(async (script: string) => {
      if (script.startsWith('window.__holiMdxReceive(')) {
        const encoded = script.slice("window.__holiMdxReceive('".length, -2)
        const payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as {
          id: string
          source: string
        }
        this.result = { id: payload.id, diagnostics: [] }
        this.receivedSource = true
        this.source = payload.source
      }
      if (script === 'window.__holiMdxTakeResult()') {
        const result = this.result
        this.result = null
        return result
      }
      return undefined
    }),
  })
  result: unknown = null
  receivedSource = false
  source = ''
  destroyed = false
  options: Record<string, unknown>
  loadURL = vi.fn(() => {
    if (state.failLoadNext) {
      state.failLoadNext = false
      return Promise.reject(new Error('guest initialization denied'))
    }
    if (state.hangLoadNext) {
      state.hangLoadNext = false
      return new Promise<void>(() => undefined)
    }
    return Promise.resolve()
  })
  destroy = vi.fn(() => {
    this.destroyed = true
    this.emit('closed')
  })
  isDestroyed = () => this.destroyed
  constructor(options: Record<string, unknown> = {}) {
    super()
    this.options = options
    state.guests.push(this)
  }
}

vi.mock('electron', () => ({
  BrowserWindow: state.BrowserWindow,
  session: { fromPartition: state.fromPartition },
  webContents: {
    fromId: vi.fn((id: number) =>
      id === -1
        ? undefined
        : {
            isDestroyed: () => id === state.destroyedContentsId,
            mainFrame: { frameTreeNodeId: id },
          },
    ),
  },
}))
vi.mock('node:fs/promises', () => ({
  readFile: (path: string) => state.reads(path),
}))

import { session } from 'electron'
import { createMdxResources } from '../src/main/mdx-resources'

beforeEach(() => {
  vi.clearAllMocks()
  state.sessions.length = 0
  state.guests.length = 0
  state.hangLoadNext = false
  state.failLoadNext = false
  state.destroyedContentsId = -2
  nextGuestId = 1
  state.BrowserWindow.mockImplementation(function (options: Record<string, unknown>) {
    return new FakeGuest(options)
  })
  state.fromPartition.mockImplementation(() => new FakeSession())
  state.reads.mockImplementation(async (path: string) => {
    if (path.endsWith('guest.html')) return Buffer.from('<html></html>')
    if (path.endsWith('guest.js')) return Buffer.from('fixed guest')
    throw new Error(`unexpected asset ${path}`)
  })
})

describe('isolated MDX compiler policy', () => {
  it('rechecks owner freshness when queued work starts', async () => {
    let current = true
    let releaseAssets!: (value: Buffer) => void
    const assetGate = new Promise<Buffer>((resolve) => (releaseAssets = resolve))
    state.reads.mockImplementation(async (path: string) => {
      if (path.endsWith('guest.html')) return assetGate
      if (path.endsWith('guest.js')) return Buffer.from('fixed guest')
      throw new Error(`unexpected asset ${path}`)
    })
    const compiler = createMdxResources('/assets')
    const owner = compiler.createOwner(async () => current)
    const first = compiler.compile(owner, '# first')
    const second = compiler.compile(owner, '# queued')
    await Promise.resolve()
    current = false
    releaseAssets(Buffer.from('<html></html>'))
    await expect(first).rejects.toThrow(/owner unavailable/)
    await expect(second).rejects.toThrow(/owner unavailable/)
    expect(state.guests).toHaveLength(0)
    compiler.close()
  })

  it('rejects oversized or already-cancelled work before creating a guest session', async () => {
    const compiler = createMdxResources('/assets')
    const owner = compiler.createOwner(async () => true)
    await expect(compiler.compile(owner, 'x'.repeat(256 * 1024 + 1))).rejects.toThrow(/256 KiB/)
    const controller = new AbortController()
    controller.abort()
    await expect(compiler.compile(owner, '# no guest', controller.signal)).rejects.toThrow(
      /cancelled/,
    )
    expect(session.fromPartition).not.toHaveBeenCalled()
    expect(state.guests).toHaveLength(0)
    compiler.close()
  })

  it('rejects forged and synchronously retired resource capabilities', async () => {
    const compiler = createMdxResources('/assets')
    const owner = compiler.createOwner(async () => true)
    await expect(compiler.compile({}, '# forged', new AbortController().signal)).rejects.toThrow(
      /owner unavailable/i,
    )
    compiler.retireOwner(owner)
    await expect(
      compiler.compile(owner, '# retired', new AbortController().signal),
    ).rejects.toThrow(/owner unavailable/i)
    expect(session.fromPartition).not.toHaveBeenCalled()
    compiler.close()
  })

  it('does not deliver source when the fixed guest fails to initialize', async () => {
    const compiler = createMdxResources('/assets')
    const owner = compiler.createOwner(async () => true)
    state.failLoadNext = true
    await expect(compiler.compile(owner, '# must not reach guest')).rejects.toThrow(
      /initialization denied/,
    )
    expect(state.guests[0].receivedSource).toBe(false)
    expect(state.guests[0].destroyed).toBe(true)
    compiler.close()
  })

  it('loads the fixed guest before delivering Unicode source through JSON data', async () => {
    const compiler = createMdxResources('/assets')
    const owner = compiler.createOwner(async () => true)
    await expect(compiler.compile(owner, '# héllo 🌱')).resolves.toEqual([])
    const guest = state.guests[0]
    expect(guest.loadURL).toHaveBeenCalledWith('https://mdx-compiler.invalid/guest.html')
    expect(guest.receivedSource).toBe(true)
    expect(guest.source).toBe('# héllo 🌱')
    const preferences = guest.options.webPreferences as Record<string, unknown>
    expect(preferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      webviewTag: false,
    })
    expect(guest.webContents.executeJavaScript.mock.calls[0][0]).not.toContain('héllo')
    expect(state.sessions[0].clearStorageData).toHaveBeenCalledTimes(2)
    expect(state.sessions[0].clearCache).toHaveBeenCalledTimes(2)
    compiler.close()
  })

  it('isolates each guest in a fresh private session and cleans it up', async () => {
    const compiler = createMdxResources('/assets')
    const owner = compiler.createOwner(async () => true)
    await compiler.compile(owner, '# one')
    await compiler.compile(owner, '# two')
    expect(session.fromPartition).toHaveBeenCalledTimes(2)
    expect(session.fromPartition).toHaveBeenCalledWith(expect.stringMatching(/^mdx-compiler-/), {
      cache: false,
    })
    expect(state.guests).toHaveLength(2)
    expect(state.guests.every((guest) => guest.destroyed)).toBe(true)
    const privateSession = state.sessions[1]
    expect(privateSession.webRequest.onBeforeRequest).toHaveBeenNthCalledWith(
      1,
      expect.any(Function),
    )
    const beforeRequest = privateSession.webRequest.onBeforeRequest.mock.calls[0][0] as (
      details: {
        url: string
        method: string
        resourceType: string
        webContentsId: number
        uploadData?: unknown[]
        frame?: { frameTreeNodeId: number }
      },
      callback: (result: { cancel: boolean }) => void,
    ) => void
    const guestId = state.guests[1].webContents.id
    for (const [url, method, resourceType, webContentsId, cancelled] of [
      ['https://mdx-compiler.invalid/guest.html', 'GET', 'mainFrame', guestId, true],
      ['https://mdx-compiler.invalid/guest.js', 'GET', 'script', guestId, true],
      ['https://mdx-compiler.invalid/guest.js', 'GET', 'script', guestId, true],
      ['https://mdx-compiler.invalid/guest.html?x=1', 'GET', 'mainFrame', guestId, true],
      ['https://example.com/', 'GET', 'mainFrame', guestId, true],
      ['https://mdx-compiler.invalid/guest.js', 'POST', 'script', guestId, true],
      ['https://mdx-compiler.invalid/guest.js', 'GET', 'image', guestId, true],
      ['https://mdx-compiler.invalid/guest.js', 'GET', 'script', guestId + 1, true],
      ['https://mdx-compiler.invalid/guest.html', 'GET', 'subFrame', guestId, true],
      ['https://mdx-compiler.invalid/guest.js', 'GET', 'script', -1, true],
      ['https://mdx-compiler.invalid/guest.js', 'GET', 'script', -2, true],
    ] as const) {
      const callback = vi.fn()
      await beforeRequest(
        {
          url,
          method,
          resourceType,
          webContentsId,
          ...(['script', 'mainFrame'].includes(resourceType)
            ? { frame: { frameTreeNodeId: guestId } }
            : {}),
        },
        callback,
      )
      expect(callback).toHaveBeenCalledWith({ cancel: cancelled })
    }
    state.destroyedContentsId = guestId
    const destroyedCallback = vi.fn()
    await beforeRequest(
      {
        url: 'https://mdx-compiler.invalid/guest.html',
        method: 'GET',
        resourceType: 'mainFrame',
        webContentsId: guestId,
        frame: { frameTreeNodeId: guestId },
      },
      destroyedCallback,
    )
    expect(destroyedCallback).toHaveBeenCalledWith({ cancel: true })
    state.destroyedContentsId = -2
    expect(privateSession.webRequest.onBeforeRequest).toHaveBeenCalledTimes(2)
    expect(privateSession.webRequest.onBeforeRequest).toHaveBeenNthCalledWith(2, null)
    expect(privateSession.protocol.handle).toHaveBeenCalledWith('https', expect.any(Function))
    const handler = privateSession.protocol.handle.mock.calls[0][1] as (
      request: Request,
    ) => Promise<Response>
    const asset = await handler(new Request('https://mdx-compiler.invalid/guest.js'))
    expect(asset.status).toBe(404)
    for (const url of [
      'https://mdx-compiler.invalid/other.js',
      'https://mdx-compiler.invalid/guest.js?x=1',
      'https://example.com/guest.js',
      'https://mdx-compiler.invalid/guest.html#fragment',
    ])
      expect((await handler(new Request(url))).status).toBe(404)
    compiler.close()
    expect(privateSession.protocol.unhandle).toHaveBeenCalledWith('https')
  })

  it('consumes the single main-frame bootstrap pair only while its owner is live', async () => {
    const compiler = createMdxResources('/assets')
    const owner = compiler.createOwner(async () => true)
    state.hangLoadNext = true
    const compiling = compiler.compile(owner, '# held')
    await vi.waitFor(() => expect(state.guests).toHaveLength(1))
    const privateSession = state.sessions[0]
    const gate = privateSession.webRequest.onBeforeRequest.mock.calls[0][0] as (
      details: {
        url: string
        method: string
        resourceType: string
        webContentsId: number
        frame?: { frameTreeNodeId: number }
      },
      callback: (result: { cancel: boolean }) => void,
    ) => void
    const guestId = state.guests[0].webContents.id
    const request = async (
      url: string,
      resourceType: string,
      details: Partial<{
        method: string
        webContentsId: number
        frame: { frameTreeNodeId: number }
      }> = {},
    ) => {
      const callback = vi.fn()
      await gate(
        {
          url,
          method: 'GET',
          resourceType,
          webContentsId: guestId,
          frame: { frameTreeNodeId: guestId },
          ...details,
        },
        callback,
      )
      return callback.mock.calls[0][0] as { cancel: boolean }
    }
    await expect(request('https://mdx-compiler.invalid/guest.html', 'mainFrame')).resolves.toEqual({
      cancel: false,
    })
    await expect(request('https://mdx-compiler.invalid/guest.js', 'script')).resolves.toEqual({
      cancel: false,
    })
    await expect(request('https://mdx-compiler.invalid/guest.js', 'script')).resolves.toEqual({
      cancel: true,
    })
    await expect(
      request('https://mdx-compiler.invalid/guest.js', 'script', { method: 'POST' }),
    ).resolves.toEqual({
      cancel: true,
    })
    await expect(request('https://mdx-compiler.invalid/guest.js', 'image')).resolves.toEqual({
      cancel: true,
    })
    await expect(
      request('https://mdx-compiler.invalid/guest.js', 'script', { webContentsId: guestId + 1 }),
    ).resolves.toEqual({ cancel: true })
    await expect(
      request('https://mdx-compiler.invalid/guest.js', 'script', {
        frame: { frameTreeNodeId: guestId + 100 },
      }),
    ).resolves.toEqual({ cancel: true })
    const handler = privateSession.protocol.handle.mock.calls[0][1] as (
      request: Request,
    ) => Promise<Response>
    let releaseAsset!: (value: Buffer) => void
    let assetReadEntered!: () => void
    const readEntered = new Promise<void>((resolve) => {
      assetReadEntered = resolve
    })
    state.reads.mockImplementationOnce(
      () =>
        new Promise<Buffer>((resolve) => {
          releaseAsset = resolve
          assetReadEntered()
        }),
    )
    const inFlightAsset = handler(new Request('https://mdx-compiler.invalid/guest.js'))
    await readEntered
    compiler.retireOwner(owner)
    releaseAsset(Buffer.from('revoked'))
    expect((await inFlightAsset).status).toBe(404)
    await expect(compiling).rejects.toThrow(/owner unavailable/i)
    compiler.close()
  })

  it('cancels queued work immediately and invalidation permits a subsequent compile', async () => {
    const compiler = createMdxResources('/assets')
    const owner = compiler.createOwner(async () => true)
    let releaseRead: (() => void) | undefined
    state.reads.mockImplementation(async (path: string) => {
      if (path.endsWith('guest.html')) {
        await new Promise<void>((resolve) => {
          releaseRead = resolve
        })
        return Buffer.from('<html></html>')
      }
      return Buffer.from('fixed guest')
    })
    const first = compiler.compile(owner, '# active')
    await vi.waitFor(() => expect(releaseRead).toBeDefined())
    const controller = new AbortController()
    const queued = compiler.compile(owner, '# queued', controller.signal)
    controller.abort()
    await expect(queued).rejects.toThrow(/cancelled/)
    compiler.invalidate()
    await expect(first).rejects.toThrow(/invalidated/)
    releaseRead?.()
    state.reads.mockImplementation(async (path: string) =>
      Buffer.from(path.endsWith('guest.html') ? '<html></html>' : 'fixed guest'),
    )
    const nextOwner = compiler.createOwner(async () => true)
    await expect(compiler.compile(nextOwner, '# latest')).resolves.toEqual([])
    compiler.close()
  })

  it('recovers from renderer crashes and a hung guest load', async () => {
    const compiler = createMdxResources('/assets')
    const owner = compiler.createOwner(async () => true)
    state.hangLoadNext = true
    const crashed = expect(compiler.compile(owner, '# crash')).rejects.toThrow(/crashed/)
    await vi.waitFor(() => expect(state.guests).toHaveLength(1))
    state.guests[0].webContents.emit('render-process-gone')
    await crashed

    state.hangLoadNext = true
    const controller = new AbortController()
    const hung = compiler.compile(owner, '# hang', controller.signal)
    await vi.waitFor(() => expect(state.guests).toHaveLength(2))
    controller.abort()
    await expect(hung).rejects.toThrow(/cancelled/)
    await expect(compiler.compile(owner, '# recovered')).resolves.toEqual([])

    state.hangLoadNext = true
    const timedOut = compiler.compile(owner, '# timeout')
    await vi.waitFor(() => expect(state.guests).toHaveLength(4))
    await expect(timedOut).rejects.toThrow(/timed out/)
    await expect(compiler.compile(owner, '# recovered after timeout')).resolves.toEqual([])
    compiler.close()
  }, 10_000)

  it('enforces the four-request bound and permanently rejects work after close', async () => {
    const compiler = createMdxResources('/assets')
    const owner = compiler.createOwner(async () => true)
    const gate = vi.fn()
    state.reads.mockImplementation(async (path: string) => {
      await new Promise<void>((resolve) => gate.mockImplementation(resolve))
      return Buffer.from(path.endsWith('guest.html') ? '<html></html>' : 'fixed guest')
    })
    const requests = [
      compiler.compile(owner, '1'),
      compiler.compile(owner, '2'),
      compiler.compile(owner, '3'),
      compiler.compile(owner, '4'),
    ]
    await expect(compiler.compile(owner, '5')).rejects.toThrow(/queue is full/)
    compiler.close()
    await expect(Promise.all(requests)).rejects.toThrow()
    expect(gate).not.toHaveBeenCalled()
  })
})
